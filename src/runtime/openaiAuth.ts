import * as vscode from 'vscode';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { createServer } from 'node:http';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const metadataKey = 'openai.profiles.v1';
const selectedKey = 'openai.selected.v1';
const hostKey = 'openai.host.v1';
const pendingClientKey = 'openai.pendingClient.v1';
const secretPrefix = 'openai.credentials.v1.';

export interface OpenAIProfile { id: string; clientId: string; subject: string; issuer: string; label: string }
export interface OpenAICredentials { clientId: string; subject: string; issuer: string; accessToken: string; refreshToken: string; idToken: string; scopes: string[]; expiresAt: number }
export type OpenAIConnectionState = 'not_connected' | 'connecting' | 'connected' | 'needs_reauthentication' | 'permission_missing' | 'usage_unavailable' | 'error';
export interface OpenAIStatus { providerId: 'openai'; state: OpenAIConnectionState; profileId?: string; label?: string; canUseModels: boolean; modelMappingComplete: boolean; action?: 'connect' | 'reconnect' | 'configure_models' | 'retry' }

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');
const equals = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const safeJson = async (response: Response): Promise<Record<string, unknown>> => {
  try { return await response.json() as Record<string, unknown>; } catch { return {}; }
};

export class OpenAIAuth {
  private readonly profileChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeProfile = this.profileChangedEmitter.event;
  private readonly connectionChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeConnection = this.connectionChangedEmitter.event;
  private setConnectionState(state: OpenAIConnectionState | undefined): void {
    if (this.transientState === state) { return; }
    this.transientState = state;
    this.connectionChangedEmitter.fire();
  }
  dispose(): void { this.profileChangedEmitter.dispose(); this.connectionChangedEmitter.dispose(); }
  private transientState?: OpenAIConnectionState;
  private refreshFlight?: Promise<OpenAICredentials>;
  constructor(private readonly context: vscode.ExtensionContext, private readonly fetcher: typeof fetch = fetch,
    private readonly launch: (uri: vscode.Uri) => Thenable<boolean> = uri => vscode.env.openExternal(uri)) {}

  async hostId(): Promise<string> {
    let id = this.context.globalState.get<string>(hostKey);
    if (!id) { id = `urn:uuid:${randomUUID()}`; await this.context.globalState.update(hostKey, id); }
    return id;
  }
  profiles(): OpenAIProfile[] { return this.context.globalState.get<OpenAIProfile[]>(metadataKey, []); }
  selectedProfile(): OpenAIProfile | undefined {
    const id = this.context.globalState.get<string>(selectedKey);
    return this.profiles().find(profile => profile.id === id);
  }
  async selectProfile(id: string): Promise<void> {
    if (!this.profiles().some(profile => profile.id === id)) { throw new Error('Saved OpenAI profile is unavailable.'); }
    await this.context.globalState.update(selectedKey, id);
    this.profileChangedEmitter.fire();
  }
  private async credentials(profile: OpenAIProfile): Promise<OpenAICredentials | undefined> {
    const raw = await this.context.secrets.get(secretPrefix + profile.id);
    if (!raw) { return undefined; }
    try {
      const value = JSON.parse(raw) as OpenAICredentials;
      return value.clientId === profile.clientId && value.subject === profile.subject && value.issuer === issuer ? value : undefined;
    } catch { return undefined; }
  }
  async status(mappingComplete = false): Promise<OpenAIStatus> {
    const profile = this.selectedProfile();
    if (this.transientState === 'connecting') { return { providerId: 'openai', state: 'connecting', profileId: profile?.id, label: profile?.label, canUseModels: false, modelMappingComplete: mappingComplete }; }
    if (!profile) { return { providerId: 'openai', state: 'not_connected', canUseModels: false, modelMappingComplete: false, action: 'connect' }; }
    const credential = await this.credentials(profile);
    const state = this.transientState ?? (!credential ? 'needs_reauthentication' : !credential.scopes.includes('chatgpt.tokens.use.direct') ? 'permission_missing' : 'connected');
    const canUseModels = state === 'connected';
    return { providerId: 'openai', state, profileId: profile.id, label: profile.label, canUseModels,
      modelMappingComplete: mappingComplete, action: !credential || state === 'needs_reauthentication' || state === 'permission_missing' ? 'reconnect' : !mappingComplete ? 'configure_models' : state === 'connected' ? undefined : 'retry' };
  }
  noteApiFailure(status: number, code?: string): void {
    if (status === 401 || code === 'subscription_sharing_invalid_user') { this.setConnectionState('needs_reauthentication'); }
    else if (status === 503 || code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable') { this.setConnectionState('usage_unavailable'); }
    else if (status === 403) { this.setConnectionState('error'); }
  }
  noteApiSuccess(): void { if (this.transientState !== 'needs_reauthentication') { this.setConnectionState(undefined); } }
  private async verifyIdentity(idToken: string, clientId: string, nonce: string): Promise<{ subject: string; issuer: string }> {
    const parts = idToken.split('.');
    if (parts.length !== 3) { throw new Error('OpenAI identity verification failed.'); }
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string };
    if (header.alg !== 'RS256' || !header.kid || claims.iss !== issuer || !claims.sub || !claims.exp || claims.exp <= Date.now() / 1000 ||
      !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) || claims.nonce !== nonce) {
      throw new Error('OpenAI identity verification failed.');
    }
    const discovery = await this.fetcher(`${issuer}/.well-known/openid-configuration`);
    if (!discovery.ok) { throw new Error('OpenAI identity verification is unavailable.'); }
    const config = await safeJson(discovery);
    if (config.issuer !== issuer || typeof config.jwks_uri !== 'string' || !config.jwks_uri.startsWith(`${issuer}/`)) { throw new Error('OpenAI identity verification failed.'); }
    const jwksResponse = await this.fetcher(config.jwks_uri);
    if (!jwksResponse.ok) { throw new Error('OpenAI identity verification is unavailable.'); }
    const jwks = await safeJson(jwksResponse);
    const key = Array.isArray(jwks.keys) ? jwks.keys.find((item: { kid?: string; kty?: string; use?: string }) => item.kid === header.kid && item.kty === 'RSA' && (!item.use || item.use === 'sig')) : undefined;
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) {
      throw new Error('OpenAI identity verification failed.');
    }
    return { subject: claims.sub, issuer: claims.iss };
  }
  private async tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.fetcher(`${issuer}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); }
    catch { throw new Error('OpenAI authentication is temporarily unavailable.'); }
    if (!response.ok) {
      const payload = await safeJson(response);
      const code = payload.error;
      if (code === 'invalid_grant' || code === 'invalid_refresh_token' || code === 'token_expired' || code === 'refresh_token_expired' || code === 'refresh_token_invalidated' || code === 'refresh_token_reused') {
        throw new Error('OpenAI sign-in expired. Reconnect your ChatGPT account.');
      }
      throw new Error('OpenAI authentication failed. Reconnect and try again.');
    }
    return safeJson(response);
  }
  async signIn(profileId?: string): Promise<OpenAIStatus> {
    if (this.transientState === 'connecting') { throw new Error('OpenAI connection is already in progress.'); }
    const prior = profileId ? this.profiles().find(item => item.id === profileId) : undefined;
    if (profileId && !prior) { throw new Error('Saved OpenAI profile is unavailable.'); }
    this.setConnectionState('connecting');
    const state = random(), nonce = random(), verifier = random(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const server = createServer();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const callback = new Promise<URL>((resolve, reject) => {
        let done = false;
        server.on('request', (request, response) => {
          if (done) { response.writeHead(410).end(); return; }
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (request.method !== 'GET' || url.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
          done = true;
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('NX Router sign-in finished. Return to VS Code.');
          resolve(url);
        });
        server.once('error', reject);
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
      const address = server.address();
      if (!address || typeof address === 'string') { throw new Error('Could not start OpenAI sign-in callback.'); }
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const authUrl = new URL(`${issuer}/api/accounts/authorize`);
      const pendingClientId = this.context.globalState.get<string>(pendingClientKey);
      const params: Record<string, string> = { client_id: prior?.clientId ?? pendingClientId ?? 'dynamic_agent_client', ext_agent_host_id: await this.hostId(),
        response_type: 'code', redirect_uri: redirectUri, scope: scopes, resource, state, nonce, code_challenge_method: 'S256', code_challenge: challenge };
      if (!prior && !pendingClientId) { params.agent_name_hint = 'NX Router'; }
      const priorCredential = prior ? await this.credentials(prior) : undefined;
      if (priorCredential?.idToken) { params.id_token_hint = priorCredential.idToken; }
      if (priorCredential && !priorCredential.scopes.includes('chatgpt.tokens.use.direct')) { params.prompt = 'consent'; }
      for (const [key, value] of Object.entries(params)) { authUrl.searchParams.set(key, value); }
      if (!await this.launch(vscode.Uri.parse(authUrl.toString()))) { throw new Error('Could not open the browser for OpenAI sign-in.'); }
      const returned = await Promise.race([callback, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('OpenAI sign-in timed out.')), 10 * 60 * 1000);
      })]);
      if (!equals(returned.searchParams.get('state') ?? '', state)) { throw new Error('OpenAI sign-in state did not match.'); }
      if (returned.searchParams.has('error')) { throw new Error('OpenAI permission was declined. Reconnect to enable ChatGPT plan usage.'); }
      const code = returned.searchParams.get('code');
      const issued = returned.searchParams.get('client_id') ?? prior?.clientId ?? pendingClientId;
      if (!code || !issued || issued === 'dynamic_agent_client' || (prior && issued !== prior.clientId) || (pendingClientId && !prior && issued !== pendingClientId)) { throw new Error('OpenAI registration was incomplete. Reconnect and try again.'); }
      if (!prior) { await this.context.globalState.update(pendingClientKey, issued); }
      const data = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code, code_verifier: verifier, redirect_uri: redirectUri, resource }));
      if (typeof data.id_token !== 'string' || typeof data.access_token !== 'string') { throw new Error('OpenAI sign-in response was incomplete.'); }
      const identity = await this.verifyIdentity(data.id_token, issued, nonce);
      if (prior && identity.subject !== prior.subject) { throw new Error('OpenAI account did not match the saved connection.'); }
      const id = createHash('sha256').update(`${identity.issuer}\0${identity.subject}\0${issued}`).digest('hex');
      const profile: OpenAIProfile = { id, clientId: issued, subject: identity.subject, issuer: identity.issuer, label: `ChatGPT ${id.slice(0, 8)}` };
      const credential: OpenAICredentials = { clientId: issued, subject: identity.subject, issuer: identity.issuer, accessToken: data.access_token,
        refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : priorCredential?.refreshToken ?? '', idToken: data.id_token,
        scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/) : [], expiresAt: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000 };
      await this.context.secrets.store(secretPrefix + id, JSON.stringify(credential));
      await this.context.globalState.update(metadataKey, [...this.profiles().filter(item => item.id !== id), profile]);
      await this.context.globalState.update(selectedKey, id);
      await this.context.globalState.update(pendingClientKey, undefined);
      this.setConnectionState(undefined);
      this.profileChangedEmitter.fire();
      return this.status();
    } catch (error) {
      this.setConnectionState(undefined);
      if (error instanceof Error && error.message.startsWith('OpenAI')) { throw error; }
      throw new Error('OpenAI sign-in failed. Please try again.');
    } finally { if (timeout) { clearTimeout(timeout); } server.close(); }
  }
  async accessToken(): Promise<string> {
    const profile = this.selectedProfile();
    if (!profile) { throw new Error('Connect OpenAI to continue.'); }
    const credential = await this.credentials(profile);
    if (!credential) { this.setConnectionState('needs_reauthentication'); throw new Error('OpenAI connection needs reauthentication.'); }
    if (!credential.scopes.includes('chatgpt.tokens.use.direct')) { this.setConnectionState('permission_missing'); throw new Error('Enable ChatGPT plan usage for NX Router.'); }
    if (credential.expiresAt > Date.now() + 60_000) { return credential.accessToken; }
    if (!this.refreshFlight) { this.refreshFlight = this.refresh(profile, credential).finally(() => { this.refreshFlight = undefined; }); }
    return (await this.refreshFlight).accessToken;
  }
  private async refresh(profile: OpenAIProfile, credential: OpenAICredentials): Promise<OpenAICredentials> {
    if (!credential.refreshToken) { this.setConnectionState('needs_reauthentication'); throw new Error('OpenAI connection needs reauthentication.'); }
    let data: Record<string, unknown>;
    try { data = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: credential.refreshToken, resource })); }
    catch (error) { if (error instanceof Error && error.message.includes('expired')) { await this.context.secrets.delete(secretPrefix + profile.id); this.setConnectionState('needs_reauthentication'); } throw error; }
    if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') { throw new Error('OpenAI credential refresh was incomplete.'); }
    const updated = { ...credential, accessToken: data.access_token, refreshToken: data.refresh_token,
      scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/) : credential.scopes,
      expiresAt: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000 };
    await this.context.secrets.store(secretPrefix + profile.id, JSON.stringify(updated));
    this.setConnectionState(undefined);
    return updated;
  }
  async disconnect(): Promise<{ revoked: boolean }> {
    const profile = this.selectedProfile();
    if (!profile) { return { revoked: true }; }
    const credential = await this.credentials(profile);
    let revoked = !credential?.refreshToken;
    if (credential?.refreshToken) {
      try {
        const discovery = await this.fetcher(`${issuer}/.well-known/openid-configuration`);
        const config = await safeJson(discovery);
        if (discovery.ok && typeof config.revocation_endpoint === 'string' && config.revocation_endpoint.startsWith(`${issuer}/`)) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await this.fetcher(config.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: credential.refreshToken, token_type_hint: 'refresh_token', client_id: profile.clientId }) });
              if (response.ok) { revoked = true; break; }
              if (response.status < 500) { break; }
            } catch { /* Retry a transient transport failure. */ }
            if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1))); }
          }
        }
      } catch { /* Local disconnect still clears credentials. */ }
    }
    await this.context.secrets.delete(secretPrefix + profile.id);
    this.setConnectionState(undefined);
    this.profileChangedEmitter.fire();
    return { revoked };
  }
}
