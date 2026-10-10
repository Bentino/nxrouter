import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expected, fixture, readFixture, verifyFixture } from '../workspace';
import { autoId } from '../acceptance';
import { acceptanceEvents, isolatedTools } from '../evidence';
import { workers } from '../provider';
import { decideRoute, parseManualOverride, validateRouterResult, collectTaskContext } from '../router';
import { Telemetry, newId, pricing, estimateCost } from '../telemetry';
import { detectCriticalUnknowns, evaluateRiskFloor } from '../guardrails';
import { createVsCodeEnricher } from '../enrichment';
import { handler, previousState, openAIStatusText } from '../extension';
import { compactSessionState, parseSessionState, updateSessionState } from '../sessionState';
import { runWorkerLoop, workerModelConfig, allowedWorkerTools, workerPrompt } from '../worker/workerLoop';
import { ProductionTool, NxToolResult } from '../worker/productionTools';
import { ReadCoverage } from '../worker/readCoverage';
import { productionTools, evaluateCommand, routeAllowsTool } from '../worker/toolPolicy';
import { resolveWorkspacePath } from '../worker/workspaceBoundary';
import { DiffContent } from '../workspace';
import { buildHandoff, corroborateObservation, evaluateEscalation, extractRuntimeEvidence, toolEvidence, validateEvidence, EscalationEvidence } from '../worker/escalation';
import { defaults, boundedInteger, modelMapping, retentionDays, executionTimeoutMs, maxReadChars, maxSearchResults } from '../config';
import { routeLabel, workerOutcome } from '../presentation';
import { NxRuntime, manualDecision, NxRuntimeEvent } from '../runtime/nxRuntime';
import { NxProvider, NxProviderManager, VsCodeLmProvider, activeProfile } from '../runtime/providers';
import { OpenAIAuth } from '../runtime/openaiAuth';
import { OpenAIProvider } from '../runtime/openaiProvider';
import { validateAutoMapping, invalidAutoMessage } from '../runtime/autoConfiguration';
import { ExecutionSessions } from '../runtime/executionSessions';
import { OpenAIAvailabilityMonitor } from '../runtime/openaiAvailabilityMonitor';
import { readinessTests } from './readiness';
import { sidebarProviderTests } from './sidebarProviders';
import { sidebarTests } from './sidebar';
import { sidebarChatTests } from './sidebarChat';
import { sidebarContextTests } from './sidebarContext';
import { sidebarHistoryTests } from './sidebarHistory';
import { sidebarPresentationTests } from './sidebarPresentation';
import { SidebarController } from '../sidebar/controller';
import { createSign, generateKeyPairSync } from 'node:crypto';

export async function run(): Promise<void> {
  const results: { name: string; status: string; detail?: string }[] = [];
  const filter = process.env.NX_TEST_FILTER;
  const test = async (name: string, fn: () => Promise<void>) => {
    if (filter && name !== 'Extension activates in real Extension Development Host' && !name.includes(filter)) { return; }
    try { await fn(); results.push({ name, status: 'passed' }); }
    catch (error) { results.push({ name, status: 'failed', detail: String(error) }); }
  };
  const token = new vscode.CancellationTokenSource();
  const root = vscode.workspace.workspaceFolders![0].uri;
  await test('Extension activates in real Extension Development Host', async () => {
    const extension = vscode.extensions.getExtension('nx-router.nx-router');
    assert.ok(extension); await extension.activate(); assert.equal(extension.isActive, true);
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace);
  });
  await sidebarTests(test);
  await sidebarChatTests(test);
  await sidebarPresentationTests(test);
  await sidebarHistoryTests(test);
  await sidebarContextTests(test);
  await sidebarProviderTests(test);
  await readinessTests(test);
  await test('Stable runtime API exports', async () => {
    for (const fn of [vscode.chat.createChatParticipant, vscode.lm.registerTool, vscode.lm.invokeTool,
      vscode.lm.selectChatModels, vscode.lm.registerLanguageModelChatProvider, vscode.tasks.executeTask]) {
      assert.equal(typeof fn, 'function');
    }
  });
  await test('UI-00 production manifest excludes fixture contributions and test manifest retains them', async () => {
    const root = path.resolve(__dirname, '../..');
    const production = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    const fixture = JSON.parse(await fs.readFile(path.join(root, 'scripts/fixture-contributions.json'), 'utf8'));
    const development = vscode.extensions.getExtension('nx-router.nx-router')!.packageJSON;
    assert.equal(production.contributes.languageModelChatProviders, undefined);
    assert.equal(production.contributes.languageModelTools.some((tool: { name: string }) => tool.name.startsWith('nx_spike_')), false);
    assert.equal(production.contributes.commands.some((item: { command: string }) => ['nxRouter.openSpike', 'nxRouter.acceptanceEvidence', 'nxRouter.cancellationTask'].includes(item.command)), false);
    assert.equal(production.contributes.configuration.properties['nxRouter.worker.fixtureModels'], undefined);
    for (const tier of ['low', 'medium', 'high']) {
      assert.equal(production.contributes.configuration.properties[`nxRouter.models.${tier}`], undefined);
      assert.ok(fixture.configuration.properties[`nxRouter.models.${tier}`]);
    }
    for (const role of ['router', 'low', 'medium', 'high']) {
      const setting = production.contributes.configuration.properties[`nxRouter.providers.openai.${role}Model`];
      assert.equal(setting.scope, 'application'); assert.equal(setting.default, '');
    }
    assert.equal(Object.keys(production.contributes.configuration.properties).some(key => /providers\.(anthropic|gemini)/.test(key)), false);
    assert.equal(fixture.languageModelChatProviders[0].vendor, 'nx-spike');
    assert.equal(development.contributes.languageModelChatProviders[0].vendor, 'nx-spike');
    assert.ok(development.contributes.languageModelTools.some((tool: { name: string }) => tool.name === 'nx_spike_workspace'));
  });
  await test('UI-01 official sign-in, protected credentials, profile mapping and inference', async () => {
    const global = new Map<string, unknown>(), secret = new Map<string, string>();
    const memento = { get: (key: string, fallback?: unknown) => global.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { global.set(key, value); }, keys: () => [...global.keys()] } as vscode.Memento;
    const context = { globalState: memento, secrets: { get: async (key: string) => secret.get(key),
      store: async (key: string, value: string) => { secret.set(key, value); }, delete: async (key: string) => { secret.delete(key); } } } as unknown as vscode.ExtensionContext;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' });
    const authUrls: URL[] = [];
    let revoked = false;
    let wrongState = false, wrongNonce = false;
    let currentAccess = 'ACCESS_SECRET', refreshCount = 0;
    let catalogModel = 'actual-model';
    let responseMode: 'final' | 'deltas' | 'textless' | 'function' | 'schema-error' = 'final';
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('openid-configuration')) { return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/revoke' }); }
      if (url.endsWith('jwks.json')) { return Response.json({ keys: [{ ...jwk, kid: 'fixture', use: 'sig' }] }); }
      if (url.endsWith('/revoke')) { revoked = true; return new Response('', { status: 200 }); }
      if (url.endsWith('/oauth/token')) {
        const params = init?.body as URLSearchParams;
        if (params.get('grant_type') === 'refresh_token') {
          assert.equal(params.get('client_id'), 'oaiapp_fixture');
          assert.equal(params.get('refresh_token'), 'REFRESH_SECRET');
          currentAccess = 'ACCESS_REFRESHED'; refreshCount++;
          return Response.json({ access_token: currentAccess, refresh_token: 'REFRESH_SECRET', expires_in: 3600 });
        }
        currentAccess = 'ACCESS_SECRET';
        const latest = authUrls.at(-1)!;
        const nonce = wrongNonce ? 'incorrect-nonce' : latest.searchParams.get('nonce');
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', sub: 'verified-subject', aud: 'oaiapp_fixture', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
        const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
        assert.equal(params.get('code_verifier')?.length! > 30, true);
        return Response.json({ id_token: `${header}.${payload}.${signature}`, access_token: 'ACCESS_SECRET', refresh_token: 'REFRESH_SECRET',
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', expires_in: 3600 });
      }
      if (url.endsWith('/models')) {
        assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${currentAccess}`);
        return Response.json({ models: [{ slug: catalogModel, display_name: 'Actual model', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' }] });
      }
      if (url.endsWith('/responses')) {
        const body = JSON.parse(String(init?.body));
        for (const item of body.input) if (Array.isArray(item.content) && item.content.some((part: any) => part.type === 'input_image')) {
          assert.deepEqual(item.content, [{ type: 'input_text', text: 'Describe the attached screenshot.' }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw==', detail: 'auto' }]);
        }
        assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.model, 'actual-model');
        if (responseMode === 'schema-error' && body.tools?.length) {
          return Response.json({ error: { code: 'invalid_function_parameters', param: 'tools[0].parameters',
            message: 'private request payload ACCESS_SECRET' } }, { status: 400 });
        }
        const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
        let stream: string;
        if (responseMode === 'deltas') {
          stream = frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'NX connection ' }) +
            frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'works.' }) +
            frame({ type: 'response.completed', response: {} });
        } else if (responseMode === 'textless') {
          stream = frame({ type: 'response.completed', response: { output: [{ type: 'reasoning', encrypted_content: 'opaque' }] } });
        } else if (responseMode === 'function') {
          if (body.input.some((item: { type?: string }) => item.type === 'function_call_output')) {
            assert.ok(body.input.some((item: { type?: string }) => item.type === 'reasoning'));
            stream = frame({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Tool result used.' }] }] } });
          } else {
            assert.equal(body.tools[0].name, 'nx_read');
            stream = frame({ type: 'response.completed', response: { output: [
              { type: 'reasoning', encrypted_content: 'opaque' },
              { type: 'function_call', call_id: 'call-1', name: 'nx_read', arguments: '{"path":"a.txt"}' }
            ] } });
          }
        } else {
          stream = frame({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'NX connection works.' }] }] } });
        }
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error('Unexpected network request.');
    }) as typeof fetch;
    const launch = async (uri: vscode.Uri) => {
      const url = new URL(uri.toString(true)); authUrls.push(url);
      const redirect = url.searchParams.get('redirect_uri');
      assert.ok(redirect, 'OAuth redirect_uri missing in browser URL');
      const callback = new URL(redirect);
      callback.searchParams.set('state', wrongState ? 'incorrect-state' : url.searchParams.get('state')!);
      callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('client_id', 'oaiapp_fixture');
      setTimeout(() => { void fetch(callback); }, 0);
      return true;
    };
    const auth = new OpenAIAuth(context, fakeFetch, launch);
    const host = await auth.hostId();
    assert.equal((await new OpenAIAuth(context, fakeFetch, launch).hostId()), host);
    const first = await auth.signIn(); assert.equal(first.state, 'connected');
    assert.equal(authUrls[0].searchParams.get('client_id'), 'dynamic_agent_client');
    assert.equal(authUrls[0].searchParams.get('ext_agent_host_id'), host);
    assert.equal(secret.size, 1);
    assert.equal(JSON.stringify([...global.values()]).includes('ACCESS_SECRET'), false);
    assert.equal(JSON.stringify(first).includes('ACCESS_SECRET'), false);
    const profile = auth.selectedProfile()!;
    const provider = new OpenAIProvider(auth, memento, fakeFetch);
    const sidebarMonitor = new OpenAIAvailabilityMonitor(provider, new ExecutionSessions(), () => {});
    const sidebar = new SidebarController(sidebarMonitor, [], () => ({ telemetryEnabled: true, workspaceLabel: 'fixture' }));
    const waitForSidebar = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt++) { await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.ok(predicate(), 'Sidebar event-driven update did not arrive');
    };
    let sidebarUpdates = 0;
    const sidebarChanged = sidebar.onDidChange(() => { sidebarUpdates++; });
    const catalogChanged = provider.onDidChangeCatalog(() => { void sidebar.refresh(); });
    const accountChanged = auth.onDidChangeProfile(() => { void sidebar.refresh(true); });
    const connectionChanged = auth.onDidChangeConnection(() => { void sidebar.refresh(); });
    const settingsChanged = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('nxRouter.providers.openai')) { void sidebar.refresh(); }
    });
    assert.deepEqual((await provider.listModels()).map(model => model.id), ['actual-model']);
    await assert.rejects(provider.setMapping('LOW', { modelId: 'foreign-model' }), /not available/);
    await assert.rejects(provider.setMapping('LOW', { modelId: 'actual-model', effort: 'high' }), /not confirmed/);
    for (const role of ['Router', 'LOW', 'MEDIUM', 'HIGH'] as const) { await provider.setMapping(role, { modelId: 'actual-model' }); }
    const native = vscode.workspace.getConfiguration('nxRouter.providers.openai');
    for (const key of ['routerModel', 'lowModel', 'mediumModel', 'highModel']) {
      assert.equal(native.inspect<string>(key)?.globalValue, 'actual-model');
    }
    assert.equal((await provider.status()).modelMappingComplete, true);
    assert.equal((await provider.testConnection('actual-model')).inference, 'OK');
    const imageModel = (await provider.resolveModel({ modelId: 'actual-model' }))!;
    const pixel = new Uint8Array([137, 80, 78, 71]);
    const imageInput = vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart('Describe the attached screenshot.'), vscode.LanguageModelDataPart.image(pixel, 'image/png')]);
    const encoded = (provider as any).toInput([imageInput]);
    assert.deepEqual(encoded, [{ role: 'user', content: [{ type: 'input_text', text: 'Describe the attached screenshot.' }, { type: 'input_image', image_url: 'data:image/png;base64,iVBORw==', detail: 'auto' }] }]);
    const imageResponse = await imageModel.sendRequest([imageInput], {}, token.token);
    for await (const _ of imageResponse.text) { /* drain fake provider stream */ }
    responseMode = 'deltas';
    assert.equal((await provider.testConnection('actual-model')).inference, 'OK');
    responseMode = 'textless';
    const textless = await provider.testConnection('actual-model');
    assert.equal(textless.inference, 'FAILED');
    assert.match(textless.message ?? '', /without text or function calls/);
    responseMode = 'function';
    const model = (await provider.resolveModel({ modelId: 'actual-model' }))!;
    const request = [vscode.LanguageModelChatMessage.User('Read a file.')];
    const tools = [{ name: 'nx_read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] as vscode.LanguageModelChatTool[];
    const response = await model.sendRequest(request, { tools }, token.token);
    const parts: vscode.LanguageModelResponsePart[] = [];
    for await (const part of response.stream) { parts.push(part as vscode.LanguageModelResponsePart); }
    const call = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
    assert.equal(call.name, 'nx_read');
    const continuation = await model.sendRequest([...request, vscode.LanguageModelChatMessage.Assistant([call]),
      vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('file body')])])], { tools }, token.token);
    let continuationText = ''; for await (const part of continuation.text) { continuationText += part; }
    assert.equal(continuationText, 'Tool result used.');
    responseMode = 'schema-error';
    assert.equal((await provider.testConnection('actual-model')).inference, 'OK');
    const rejected = await model.sendRequest(request, { tools }, token.token);
    await assert.rejects(async () => { for await (const _part of rejected.stream) { /* consume failure */ } }, error => {
      assert.match(String(error), /HTTP 400; code invalid_function_parameters; field tools\[0\]\.parameters/);
      assert.doesNotMatch(String(error), /private request payload|ACCESS_SECRET/);
      return true;
    });
    responseMode = 'final';
    auth.noteApiFailure(503);
    await waitForSidebar(() => sidebar.state().providers[0]?.connection === 'usage_unavailable');
    assert.equal((await provider.refreshConfiguration()).state, 'connected');
    await waitForSidebar(() => sidebar.state().providers[0]?.connection === 'connected');
    assert.equal((await provider.resolveModel({ modelId: 'hidden-model' })), undefined);
    const config = await provider.configuration();
    assert.equal(config.mappings.Router.modelId, 'actual-model');
    assert.equal(config.mappings.MEDIUM.modelId, 'actual-model');
    assert.equal(config.modelMappingComplete, true);
    assert.equal(config.auto.available, true);
    assert.match(openAIStatusText(config), /Auto available: yes/);
    assert.match(openAIStatusText(config), /MEDIUM -> actual-model \(available\)/);
    assert.equal(JSON.stringify(config).includes('ACCESS_SECRET'), false);
    const legacyModels = vscode.workspace.getConfiguration('nxRouter.models');
    try {
      await legacyModels.update('medium', 'legacy-bridge-only', vscode.ConfigurationTarget.Global);
      assert.equal(modelMapping('MEDIUM'), 'legacy-bridge-only');
      assert.equal(provider.profile().auto.tiers.MEDIUM.modelId, 'actual-model');
      assert.equal((await provider.configuration()).mappings.MEDIUM.modelId, 'actual-model');
    } finally { await legacyModels.update('medium', undefined, vscode.ConfigurationTarget.Global); }
    const oldKey = `openai.mapping.v1.${profile.id}`;
    await memento.update(oldKey, { router: { modelId: 'foreign-model' }, tiers: { LOW: { modelId: 'foreign-model' } } });
    assert.equal(provider.profile().auto.router.modelId, 'actual-model');
    assert.equal((await provider.configuration()).auto.available, true);
    await provider.listModels();
    assert.equal(native.inspect<string>('routerModel')?.globalValue, 'actual-model');
    for (const key of ['routerModel', 'lowModel', 'mediumModel', 'highModel']) { await native.update(key, undefined, vscode.ConfigurationTarget.Global); }
    await memento.update(oldKey, { router: { modelId: 'stale-model' }, tiers: {
      LOW: { modelId: 'actual-model' }, MEDIUM: { modelId: 'actual-model' }, HIGH: { modelId: 'actual-model' } } });
    await provider.listModels();
    assert.equal(native.inspect<string>('routerModel')?.globalValue, undefined);
    assert.equal(memento.get(oldKey) !== undefined, true);
    await memento.update(oldKey, { router: { modelId: 'actual-model' }, tiers: {
      LOW: { modelId: 'actual-model' }, MEDIUM: { modelId: 'actual-model' }, HIGH: { modelId: 'actual-model' } } });
    await provider.listModels();
    assert.equal(native.inspect<string>('mediumModel')?.globalValue, 'actual-model');
    assert.equal(memento.get(oldKey), undefined);
    await native.update('mediumModel', 'user-choice', vscode.ConfigurationTarget.Global);
    await waitForSidebar(() => sidebar.state().providers[0]?.mappings.find(item => item.role === 'MEDIUM')?.modelId === 'user-choice');
    assert.equal(sidebar.state().providers[0].autoAvailable, false);
    await memento.update(oldKey, { router: { modelId: 'actual-model' }, tiers: {
      LOW: { modelId: 'actual-model' }, MEDIUM: { modelId: 'actual-model' }, HIGH: { modelId: 'actual-model' } } });
    await provider.listModels();
    assert.equal(native.inspect<string>('mediumModel')?.globalValue, 'user-choice');
    assert.equal((await provider.configuration()).mappings.MEDIUM.validity, 'unavailable');
    assert.match(openAIStatusText(await provider.configuration()), /MEDIUM -> user-choice \(unavailable\)/);
    await native.update('mediumModel', 'actual-model', vscode.ConfigurationTarget.Global);
    try { await native.update('mediumModel', 'workspace-override', vscode.ConfigurationTarget.Workspace); }
    catch { /* application-scoped settings reject workspace writes in VS Code */ }
    assert.equal(provider.profile().auto.tiers.MEDIUM.modelId, 'actual-model');
    assert.equal((await provider.configuration()).auto.available, true);
    const second = { ...profile, id: 'second-profile', label: 'Second profile' };
    await memento.update('openai.profiles.v1', [profile, second]);
    secret.set(`openai.credentials.v1.${second.id}`, secret.get([...secret.keys()][0])!);
    let switches = 0;
    const changed = auth.onDidChangeProfile(() => { switches++; });
    catalogModel = 'another-model';
    await auth.selectProfile(second.id);
    await waitForSidebar(() => sidebar.state().providers[0]?.autoAvailable === false);
    const switchedConfig = await provider.refreshConfiguration();
    assert.equal(switchedConfig.auto.available, false);
    await sidebar.refresh(); assert.equal(sidebar.state().providers[0].autoAvailable, false);
    assert.equal(switchedConfig.mappings.MEDIUM.modelId, 'actual-model');
    assert.equal(switchedConfig.mappings.MEDIUM.validity, 'unavailable');
    assert.equal(native.inspect<string>('mediumModel')?.globalValue, 'actual-model');
    catalogModel = 'actual-model';
    await auth.selectProfile(profile.id);
    await waitForSidebar(() => sidebar.state().providers[0]?.autoAvailable === true);
    assert.equal((await provider.refreshConfiguration()).auto.available, true);
    await sidebar.refresh();
    assert.equal(sidebar.state().providers[0].autoAvailable, true);
    assert.ok(sidebarUpdates > 0);
    assert.doesNotMatch(JSON.stringify(sidebar.state()), /ACCESS_SECRET|REFRESH_SECRET|PRIVATE_PROFILE|subject|profileId/);
    assert.equal(switches, 2);
    changed.dispose();
    secret.delete(`openai.credentials.v1.${second.id}`);
    await memento.update('openai.profiles.v1', [profile]);
    const secretKey = [...secret.keys()][0];
    const expiring = JSON.parse(secret.get(secretKey)!); expiring.expiresAt = 0;
    secret.set(secretKey, JSON.stringify(expiring));
    assert.equal(await auth.accessToken(), 'ACCESS_REFRESHED');
    assert.equal(refreshCount, 1);
    assert.equal(JSON.parse(secret.get(secretKey)!).refreshToken, 'REFRESH_SECRET');
    assert.equal(JSON.stringify([...global.values()]).includes('ACCESS_REFRESHED'), false);
    await auth.signIn(profile.id);
    assert.equal(authUrls[1].searchParams.get('client_id'), 'oaiapp_fixture');
    assert.notEqual(authUrls[0].searchParams.get('state'), authUrls[1].searchParams.get('state'));
    assert.notEqual(authUrls[0].searchParams.get('nonce'), authUrls[1].searchParams.get('nonce'));
    assert.notEqual(authUrls[0].searchParams.get('code_challenge'), authUrls[1].searchParams.get('code_challenge'));
    const withoutSharing = JSON.parse(secret.get(secretKey)!);
    withoutSharing.scopes = withoutSharing.scopes.filter((scope: string) => scope !== 'chatgpt.tokens.use.direct');
    secret.set(secretKey, JSON.stringify(withoutSharing));
    assert.equal((await auth.status()).state, 'permission_missing');
    await auth.signIn(profile.id);
    assert.equal(authUrls[2].searchParams.get('prompt'), 'consent');
    assert.equal((await auth.disconnect()).revoked, true); assert.equal(revoked, true); assert.equal(secret.size, 0);
    assert.equal((await auth.status()).state, 'needs_reauthentication');
    wrongState = true;
    await assert.rejects(auth.signIn(profile.id), /state did not match/);
    wrongState = false; wrongNonce = true;
    await assert.rejects(auth.signIn(profile.id), /identity verification failed/);
    assert.equal(secret.size, 0);
    sidebarChanged.dispose(); catalogChanged.dispose(); accountChanged.dispose(); connectionChanged.dispose(); settingsChanged.dispose();
    sidebar.dispose(); sidebarMonitor.dispose(); provider.dispose(); auth.dispose();
    for (const key of ['routerModel', 'lowModel', 'mediumModel', 'highModel']) { await native.update(key, undefined, vscode.ConfigurationTarget.Global); }
  });
  await test('UI-01 Auto validation and session toggle transitions', async () => {
    const profile = activeProfile(true);
    const catalog = ['gpt-6-luna', 'spike-low', 'spike-medium', 'spike-high'];
    assert.equal(validateAutoMapping(profile, catalog, true).available, true);
    for (const role of ['Router', 'LOW', 'MEDIUM', 'HIGH'] as const) {
      const invalid = structuredClone(profile);
      if (role === 'Router') { invalid.auto.router.modelId = ''; }
      else { invalid.auto.tiers[role].modelId = ''; }
      const result = validateAutoMapping(invalid, catalog, true);
      assert.equal(result.available, false); assert.equal(result.mappings[role].validity, 'unconfigured');
      assert.match(invalidAutoMessage(result), new RegExp(role));
    }
    const missing = validateAutoMapping(profile, catalog.filter(id => id !== 'spike-medium'), true);
    assert.equal(missing.available, false);
    assert.equal(missing.mappings.MEDIUM.validity, 'unavailable');
    assert.equal(validateAutoMapping(profile, catalog, false).available, false);
    const sessions = new ExecutionSessions();
    assert.equal(sessions.getOrCreate('valid', true).autoOn, true);
    assert.equal(sessions.getOrCreate('invalid', false).autoOn, false);
    sessions.reconcile(false);
    assert.equal(sessions.getOrCreate('valid', true).autoOn, false);
    assert.equal(sessions.setAuto('valid', true, true).autoOn, true);
    sessions.reconcile(false);
    assert.equal(sessions.getOrCreate('valid', true).autoOn, false);
    assert.equal(sessions.setAuto('valid', true, false).autoOn, false);
    assert.equal(sessions.setAuto('valid', true, true).autoOn, true);
    const manual = sessions.setManual('valid', { modelId: 'spike-low', effort: 'low' });
    assert.equal(manual.autoOn, false); assert.equal(manual.manual?.modelId, 'spike-low');
    const warnings: string[] = [];
    const monitor = new OpenAIAvailabilityMonitor({ configuration: async () => ({ state: 'connected', profileId: 'profile', auto: missing }) } as OpenAIProvider,
      sessions, message => warnings.push(message));
    await monitor.refresh(); await monitor.refresh();
    assert.equal(warnings.length, 1); assert.match(warnings[0], /Configure Models/);
  });
  await test('UI-01 runtime rejects invalid Auto and permits valid Manual without Router', async () => {
    const profile = activeProfile(true);
    const invalid = validateAutoMapping(profile, ['spike-low', 'spike-high'], true);
    const calls: string[] = [];
    const provider: NxProvider = { id: 'nx-spike', label: 'Fixture', connectionStatus: async () => 'connected',
      listModels: async () => [{ id: 'spike-low', name: 'Low' }], autoAvailability: async () => invalid,
      resolveModel: async selection => {
        calls.push(selection.modelId);
        if (selection.modelId !== 'spike-low') { return undefined; }
        return { id: selection.modelId, vendor: 'nx-spike', countTokens: async () => 1,
          sendRequest: async () => ({ stream: (async function* () { yield new vscode.LanguageModelTextPart('Manual response.'); })() }) } as unknown as vscode.LanguageModelChat;
      } };
    const records: object[] = [];
    const telemetry = { startSession: async () => {}, recordModel: async (r: object) => { records.push(r); },
      recordTurn: async (r: object) => { records.push(r); }, recordTool: async () => {} } as unknown as Telemetry;
    const runtime = new NxRuntime(telemetry, new NxProviderManager([provider]));
    const base = { text: 'read the file', references: [], profile, token: token.token };
    const auto = await runtime.run({ ...base, execution: { mode: 'auto', providerId: 'nx-spike' } }, () => {});
    assert.match(auto.errorDetails?.message ?? '', /did not complete/);
    assert.equal(calls.length, 0);
    const manual = await runtime.run({ ...base, execution: { mode: 'manual', providerId: 'nx-spike', model: { modelId: 'spike-low' } } }, () => {});
    assert.equal(manual.errorDetails, undefined);
    assert.equal(manual.metadata?.nxTurn?.routingMode, 'manual');
    assert.equal(manual.metadata?.nxTurn?.modelId, 'spike-low');
    assert.equal(records.some((record: any) => record.role === 'router'), false);
    const missing = await runtime.run({ ...base, execution: { mode: 'manual', providerId: 'nx-spike', model: { modelId: 'not-in-catalog' } } }, () => {});
    assert.ok(missing.errorDetails);
    assert.equal(calls.includes('not-in-catalog'), true);
    assert.equal(records.some((record: any) => record.model === 'not-in-catalog'), false);
  });
  await test('UI-00 provider profile and direct runtime manual turn retain safety policy', async () => {
    const profile = activeProfile(true);
    assert.equal(profile.providerId, 'nx-spike');
    assert.equal(profile.auto.tiers.HIGH.modelId, 'spike-high');
    const records: object[] = [];
    const fakeTelemetry = { startSession: async () => {}, recordModel: async (record: object) => { records.push(record); },
      recordTurn: async (record: object) => { records.push(record); }, recordTool: async () => {} } as unknown as Telemetry;
    const runtime = new NxRuntime(fakeTelemetry, new NxProviderManager([new VsCodeLmProvider('nx-spike', 'Fixture')]));
    const events: NxRuntimeEvent[] = [];
    const manual = await runtime.run({ text: 'change authentication permissions', references: [], profile,
      execution: { mode: 'manual', providerId: 'nx-spike', model: { modelId: 'spike-low', effort: 'high' } }, token: token.token },
      event => events.push(event));
    assert.equal(manual.metadata?.nxTurn?.routingMode, 'manual');
    assert.equal(manual.metadata?.nxTurn?.providerId, 'nx-spike');
    assert.equal(manual.metadata?.nxTurn?.modelId, 'spike-low');
    assert.equal(manual.metadata?.nxTurn?.effort, 'high');
    assert.equal(manual.metadata?.nxTurn?.actualRoute, 'HIGH');
    assert.equal(records.filter((record: any) => record.role === 'router').length, 0);
    assert.equal(events.some(event => event.type === 'escalation'), false);
    assert.equal(allowedWorkerTools('HIGH', 'change authentication permissions', false).some(tool => tool.name.startsWith('nx_spike_')), false);
    assert.equal(routeAllowsTool('HIGH', 'nx_execute'), true);
    assert.equal(evaluateCommand('rm', ['-rf', '/']).allowed, false);
    assert.equal(manualDecision({ userPrompt: 'change authentication permissions' }).finalRoute, 'HIGH');
    await assert.rejects(runtime.run({ text: 'read', references: [], profile, previousProviderId: 'other',
      execution: { mode: 'auto', providerId: 'nx-spike' }, token: token.token }, () => {}), /explicit provider boundary/);
    const switched = await runtime.run({ text: 'read', references: [], profile, previousProviderId: 'other',
      providerBoundary: { explicit: true, fromProviderId: 'other' }, sessionId: manual.metadata!.nxSessionState!.sessionId,
      previous: manual.metadata!.nxSessionState,
      execution: { mode: 'manual', providerId: 'nx-spike', model: { modelId: 'spike-low' } }, token: token.token }, () => {});
    assert.equal(switched.metadata?.nxSessionState?.sessionId, manual.metadata?.nxSessionState?.sessionId);
    assert.notEqual(switched.metadata?.nxTurn?.segmentId, manual.metadata?.nxTurn?.segmentId);
  });
  await test('IMP-08 settings defaults, custom models and bounded invalid values', async () => {
    const manifest = vscode.extensions.getExtension('nx-router.nx-router')!.packageJSON;
    const properties = manifest.contributes.configuration.properties;
    for (const [tier, id] of Object.entries(defaults.models)) {
      assert.equal(properties[`nxRouter.models.${tier.toLowerCase()}`].default, id);
    }
    for (const name of ['nxRouter.telemetry.enabled', 'nxRouter.telemetry.retentionDays', 'nxRouter.execution.timeoutSeconds',
      'nxRouter.tools.maxReadChars', 'nxRouter.tools.maxSearchResults']) { assert.ok(properties[name]); }
    const fixture = vscode.workspace.getConfiguration('nxRouter.worker');
    const models = vscode.workspace.getConfiguration('nxRouter.models');
    try {
      await fixture.update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
      for (const tier of ['LOW', 'MEDIUM', 'HIGH'] as const) {
        assert.equal(workerModelConfig(tier).id, defaults.models[tier]);
        await models.update(tier.toLowerCase(), `custom-${tier.toLowerCase()}`, vscode.ConfigurationTarget.Global);
        assert.equal(modelMapping(tier), `custom-${tier.toLowerCase()}`);
        assert.equal(workerModelConfig(tier).id, `custom-${tier.toLowerCase()}`);
      }
      await models.update('high', '', vscode.ConfigurationTarget.Global);
      assert.throws(() => modelMapping('HIGH'), /nxRouter.models.high/);
    } finally {
      for (const tier of ['LOW', 'MEDIUM', 'HIGH'] as const) { await models.update(tier.toLowerCase(), undefined, vscode.ConfigurationTarget.Global); }
      await fixture.update('fixtureModels', true, vscode.ConfigurationTarget.Workspace);
    }
    assert.equal(boundedInteger(-1, 90, 1, 3650), 90);
    assert.equal(boundedInteger(0, 30, 1, 120), 30);
    assert.equal(boundedInteger(0, 30, 1, 100), 30);
    assert.equal(retentionDays(), 90); assert.equal(executionTimeoutMs(), 30000);
    assert.equal(maxReadChars(), 65536); assert.equal(maxSearchResults(), 30);
  });
  await test('IMP-08 route and outcome presentation stays factual', async () => {
    assert.equal(routeLabel('LOW', 'LOW'), 'NX · LOW');
    assert.equal(routeLabel('MEDIUM', 'MEDIUM'), 'NX · MEDIUM');
    assert.equal(routeLabel('HIGH', 'HIGH'), 'NX · HIGH');
    assert.match(routeLabel('MEDIUM', 'HIGH'), /MEDIUM → HIGH/);
    assert.match(routeLabel('LOW', 'HIGH', 'LOW', 'access-control change'), /Requested LOW; safety upgrade: access-control change/);
    const base = { status: 'partial' as const, stopReason: 'completed' as const, summary: '', iterations: 2, toolCalls: 1,
      actions: [], verification: [], unresolved: ['Change was not verified.'], changedTargets: ['file.ts'], finalRoute: 'HIGH' as const,
      escalations: [], escalationCompleted: true };
    assert.match(workerOutcome(base), /Not verified/);
    assert.doesNotMatch(workerOutcome(base), /Verified:/);
    assert.match(workerOutcome({ ...base, stopReason: 'model_unavailable', changedTargets: [] }), /nxRouter.models.high/);
    assert.match(workerOutcome({ ...base, stopReason: 'tool_rejected', changedTargets: [] }), /not applied/);
    assert.match(workerOutcome({ ...base, stopReason: 'max_iterations', changedTargets: [] }), /iteration limit/);
    assert.equal(workerOutcome({ ...base, status: 'cancelled' }), '');
  });
  await test('IMP-05 bounded worker model/tool loop and guarded model selection', async () => {
    const base = { task: { userPrompt: 'read fixture' }, normalizedTask: 'read fixture', references: [], token: token.token,
      stream: (_text: string) => {}, onModelRequest: async (_model: vscode.LanguageModelChat, _messages: vscode.LanguageModelChatMessage[], run: () => Promise<string>) => run(),
      onToolEvent: async (_event: unknown) => {} };
    for (const route of ['LOW', 'MEDIUM', 'HIGH'] as const) { assert.equal(workerModelConfig(route).id, workers[route]); }
    const decision = await decideRoute({ userPrompt: 'Implement server-side Division permissions.' }, 'MEDIUM', async () => JSON.stringify({
      normalized_task: 'Implement server-side Division permissions.', intent: 'implement', complexity: 'medium', risk: 'medium', confidence: .9,
      explicit_requirements: [], inferred_context: [], unknowns: [], route: 'MEDIUM', reason: 'Fixture.' }));
    assert.equal(decision.initialRoute, 'MEDIUM'); assert.equal(decision.finalRoute, 'HIGH');
    let selected: string | undefined;
    const makeModel = (sequences: Array<Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>>) => ({
      id: 'fixture', vendor: 'nx-spike', async sendRequest(messages: vscode.LanguageModelChatMessage[]) {
        const parts = sequences.shift() ?? [new vscode.LanguageModelTextPart('done')];
        return { stream: (async function* () { for (const part of parts) { yield part; } })() };
      }
    } as unknown as vscode.LanguageModelChat);
    const noTool = await runWorkerLoop({ ...base, route: decision.finalRoute,
      selectModel: async route => { selected = route; return makeModel([[new vscode.LanguageModelTextPart('done')]]); } });
    assert.equal(selected, 'HIGH'); assert.equal(noTool.stopReason, 'completed'); assert.equal(noTool.iterations, 1); assert.equal(noTool.toolCalls, 0);
    const calls = [new vscode.LanguageModelToolCallPart('a', isolatedTools.read, {}), new vscode.LanguageModelToolCallPart('b', isolatedTools.verify, {})];
    const results: string[] = []; const events: string[] = []; let requests = 0;
    const multi = await runWorkerLoop({ ...base, route: 'MEDIUM',
      selectModel: async () => ({ id: 'fixture', vendor: 'nx-spike', async sendRequest(messages: vscode.LanguageModelChatMessage[]) {
        requests++;
        const prior = messages.at(-1)?.content.filter(p => p instanceof vscode.LanguageModelToolResultPart) ?? [];
        if (prior.length) { results.push((prior[0].content[0] as vscode.LanguageModelTextPart).value); }
        const part = requests <= 2 ? calls[requests - 1] : new vscode.LanguageModelTextPart('done');
        return { stream: (async function* () { yield part; })() };
      } } as unknown as vscode.LanguageModelChat),
      invokeTool: async name => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(name === isolatedTools.verify ? 'Native Task exited with code 0.' : 'read succeeded')]),
      onToolEvent: async e => { events.push(e.outcome); } });
    assert.equal(multi.stopReason, 'completed'); assert.equal(multi.iterations, 3); assert.equal(multi.toolCalls, 2);
    assert.deepEqual(results, ['read succeeded', 'Native Task exited with code 0.']); assert.deepEqual(events, ['success', 'success']);
    const repeated = await runWorkerLoop({ ...base, route: 'LOW', maxIterations: 8,
      selectModel: async () => makeModel(Array.from({ length: 8 }, (_, i) => [new vscode.LanguageModelToolCallPart(String(i), isolatedTools.read, {})])),
      invokeTool: async () => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('same')]) });
    assert.equal(repeated.stopReason, 'no_progress'); assert.equal(repeated.iterations, 3);
    let invoked = 0;
    const invalid = await runWorkerLoop({ ...base, route: 'LOW',
      selectModel: async () => makeModel([[new vscode.LanguageModelToolCallPart('bad', isolatedTools.verify, {})], [new vscode.LanguageModelTextPart('stop')]]),
      invokeTool: async () => { invoked++; throw Error('must not call'); } });
    assert.equal(invoked, 0); assert.equal(invalid.status, 'partial');
    const unavailable = await runWorkerLoop({ ...base, route: 'HIGH', selectModel: async () => undefined });
    assert.equal(unavailable.stopReason, 'model_unavailable');
    const limited = await runWorkerLoop({ ...base, route: 'LOW', maxIterations: 1,
      selectModel: async () => makeModel([[new vscode.LanguageModelToolCallPart('one', isolatedTools.read, {})]]),
      invokeTool: async () => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('read')]) });
    assert.equal(limited.stopReason, 'max_iterations'); assert.equal(limited.iterations, 1);
    const rejected = await runWorkerLoop({ ...base, route: 'LOW',
      selectModel: async () => makeModel([[new vscode.LanguageModelToolCallPart('rejected', isolatedTools.write, {})]]),
      invokeTool: async () => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Write rejected or cancelled; no changes applied.')]) });
    assert.equal(rejected.stopReason, 'tool_rejected'); assert.equal(rejected.status, 'partial');
    const failedTool = await runWorkerLoop({ ...base, route: 'LOW',
      selectModel: async () => makeModel([[new vscode.LanguageModelToolCallPart('error', isolatedTools.read, {})], [new vscode.LanguageModelTextPart('Could not read')]]),
      invokeTool: async () => { throw Error('read failed'); } });
    assert.equal(failedTool.status, 'partial'); assert.match(failedTool.unresolved[0], /read failed/);
    const cancelledToken = new vscode.CancellationTokenSource(); cancelledToken.cancel();
    try {
      const cancelled = await runWorkerLoop({ ...base, route: 'LOW', token: cancelledToken.token,
        selectModel: async () => { throw Error('must not select'); } });
      assert.equal(cancelled.stopReason, 'cancelled'); assert.equal(cancelled.toolCalls, 0);
    } finally { cancelledToken.dispose(); }
  });
  await test('IMP-02 routing fixtures, compact continuation, and schema validation', async () => {
    const cases = [
      ['Change a module display name from Old to New.', 'LOW'],
      ['Fix LINE SHOP pagination where root cause is known.', 'MEDIUM'],
      ['Implement server-side Division permission/access rules.', 'HIGH'],
      ['Change a populated field schema while preserving existing data.', 'HIGH']
    ] as const;
    const fixture = (task: string, route: string) => JSON.stringify({ normalized_task: task, intent: 'implement',
      complexity: route.toLowerCase(), risk: route.toLowerCase(), confidence: 0.94,
      explicit_requirements: [task], inferred_context: [], unknowns: [], route, reason: 'Fixture policy route.' });
    for (const [task, route] of cases) {
      const decision = await decideRoute({ userPrompt: task }, undefined, async () => fixture(task, route));
      assert.equal(decision.finalRoute, route);
    }
    const continuation = collectTaskContext('ทำต่อเลย', { lastWorkerSummary: 'Implement the LINE SHOP pagination fix.' }, undefined);
    assert.match(continuation.recentTaskState!, /pagination/);
    assert.equal((await decideRoute(continuation, undefined, async () => fixture('Continue implementing LINE SHOP pagination fix.', 'MEDIUM'))).finalRoute, 'MEDIUM');
    const unclear = await decideRoute({ userPrompt: 'อ่า แก้ไขหน่อย' }, undefined, async () => { throw Error('unavailable'); });
    assert.equal(unclear.finalRoute, 'MEDIUM');
    assert.throws(() => validateRouterResult(fixture('Classify this prompt using routing policy', 'LOW'), { userPrompt: 'Fix pagination' }), /normalized_task/);
  });
  await test('IMP-04 bounded state, continuity, replacement and corrupt metadata', async () => {
    const sessionId = newId();
    const first = updateSessionState(undefined, { sessionId, prompt: 'Fix LINE SHOP pagination', normalizedTask: 'Fix LINE SHOP pagination offset',
      intent: 'implement', route: 'MEDIUM', activeTarget: 'src/line/LineShopClient.php', status: 'completed',
      action: 'Changed offset calculation', outcome: 'Focused test passed', pendingNextStep: 'Run focused pagination tests' });
    assert.equal(first.version, 1); assert.match(first.currentObjective!, /pagination/);
    const continued = updateSessionState(first, { sessionId, prompt: 'ทำต่อเลย', intent: 'continue', route: 'MEDIUM', status: 'completed', outcome: 'Continued work' });
    assert.equal(continued.currentObjective, first.currentObjective); assert.equal(continued.phase, 'implement');
    assert.match(collectTaskContext('ทำต่อเลย', continued, undefined).recentTaskState!, /offset/);
    const testing = updateSessionState(continued, { sessionId, prompt: 'ลอง test', route: 'MEDIUM', status: 'completed', outcome: 'Focused test failed' });
    assert.equal(testing.phase, 'test'); assert.match(collectTaskContext('ลอง test', testing, undefined).recentTaskState!, /pagination/);
    const failed = updateSessionState(testing, { sessionId, prompt: 'ยังไม่ผ่าน แก้ต่อ', route: 'MEDIUM', status: 'failed',
      error: 'expected page 2, got page 1', outcome: 'Focused test failed' });
    assert.equal(failed.phase, 'debug'); assert.match(failed.recentError!, /page 2/);
    const replacement = updateSessionState(failed, { sessionId, prompt: 'ทีนี้ช่วยดู permission ของ Division ต่อ',
      normalizedTask: 'Fix Division access permissions', intent: 'implement', route: 'HIGH', status: 'completed' });
    assert.match(replacement.currentObjective!, /Division/); assert.ok(!compactSessionState(replacement)!.includes('pagination'));
    assert.ok(!collectTaskContext('ทีนี้ช่วยดู permission ของ Division ต่อ', failed, undefined).recentTaskState);
    assert.equal(parseSessionState({ ...first, version: 2 }), undefined);
    assert.equal(parseSessionState({ ...first, activeTargets: null }), undefined);
    assert.equal(parseSessionState('garbage'), undefined);
    const historyTurn = (state: unknown) => Object.assign(Object.create(vscode.ChatResponseTurn.prototype),
      { participant: 'nx-router.spike', result: { metadata: { nxSessionState: state } } }) as vscode.ChatResponseTurn;
    assert.equal(previousState({ history: [] }), undefined);
    assert.equal(previousState({ history: [historyTurn(first)] })?.sessionId, sessionId);
    assert.equal(previousState({ history: [historyTurn(first), historyTurn({ ...first, version: 2 })] }), undefined);
    assert.ok(!JSON.stringify(updateSessionState(undefined, { sessionId, prompt: 'Fix key api_key=secret123 Bearer abc123', status: 'completed' })).includes('secret123'));
    assert.deepEqual(updateSessionState(failed, { sessionId, prompt: 'ทำต่อเลย', status: 'cancelled' }), failed);
    let rolling = first;
    for (let i = 0; i < 100; i++) {
      rolling = updateSessionState(rolling, { sessionId, prompt: 'ทำต่อเลย', route: 'MEDIUM', status: 'completed',
        action: 'x'.repeat(2000), outcome: 'y'.repeat(2000), error: 'z'.repeat(2000) });
    }
    assert.ok(JSON.stringify(rolling).length < 3000); assert.equal(rolling.recentActions.length, 4);
    const override = parseManualOverride('/low rename label');
    const next = updateSessionState(first, { sessionId, prompt: override.task, route: 'LOW', status: 'completed' });
    assert.equal(next.route, 'LOW'); assert.ok(!JSON.stringify(next).includes('/low'));
    const risk = await decideRoute(collectTaskContext('ทำต่อเลย', replacement, undefined), 'LOW', async () => JSON.stringify({
      normalized_task: 'Fix Division access permissions', intent: 'implement', complexity: 'low', risk: 'low', confidence: .9,
      explicit_requirements: [], inferred_context: [], unknowns: [], route: 'LOW', reason: 'Fixture.' }));
    assert.equal(risk.finalRoute, 'HIGH');
    const noState = await decideRoute(collectTaskContext('ทำต่อเลย', undefined, undefined), undefined, async () => JSON.stringify({
      normalized_task: 'ทำต่อเลย', intent: 'continue', complexity: 'low', risk: 'low', confidence: .9,
      explicit_requirements: [], inferred_context: [], unknowns: [], route: 'LOW', reason: 'Fixture.' }));
    assert.equal(noState.finalRoute, 'MEDIUM');
  });
  await test('IMP-04 participant handler carries session metadata through four turns', async () => {
    const history: (vscode.ChatRequestTurn | vscode.ChatResponseTurn)[] = [];
    const prompts = ['/medium fix pagination fixture', 'ทำต่อเลย', 'ลอง test', 'ทีนี้ช่วยแก้ permission ของ Division ต่อ'];
    const states = [];
    for (const prompt of prompts) {
      const output: string[] = [];
      const request = { prompt, references: [], command: undefined, toolInvocationToken: undefined } as unknown as vscode.ChatRequest;
      const stream = { markdown: (text: string) => { output.push(text); return stream; }, reference: () => stream } as unknown as vscode.ChatResponseStream;
      const result = await handler(request, { history }, stream, token.token);
      assert.ok(!result?.errorDetails, output.join(''));
      const state = parseSessionState(result?.metadata?.nxSessionState);
      assert.ok(state); states.push(state);
      const response = Object.assign(Object.create(vscode.ChatResponseTurn.prototype), { participant: 'nx-router.spike', result });
      history.push(response);
    }
    assert.equal(states[0].sessionId, states[3].sessionId);
    assert.equal(states[1].currentObjective, states[0].currentObjective);
    assert.equal(states[2].phase, 'test');
    assert.match(states[3].currentObjective!, /permission|Division/i);
    assert.equal(states[3].route, 'HIGH');
  });
  await test('IMP-05 Extension Host worker roundtrip groups telemetry under one turn', async () => {
    const before = acceptanceEvents.length;
    const output: string[] = [];
    const request = { prompt: '/medium read fixture', references: [], command: undefined, toolInvocationToken: undefined } as unknown as vscode.ChatRequest;
    const stream = { markdown: (text: string) => { output.push(text); return stream; }, reference: () => stream } as unknown as vscode.ChatResponseStream;
    const response = await handler(request, { history: [] }, stream, token.token);
    assert.ok(!response?.errorDetails, output.join(''));
    assert.ok(parseSessionState(response?.metadata?.nxSessionState));
    const events = acceptanceEvents.slice(before) as Array<{ event: string; worker?: string; resultCallIds?: string[] }>;
    const workerEvents = events.filter(event => event.event === 'worker');
    assert.equal(workerEvents.length, 2); assert.ok(workerEvents.every(event => event.worker === workers.MEDIUM));
    assert.ok(workerEvents[1].resultCallIds?.length);
    await vscode.commands.executeCommand('nxRouter.exportSessionTelemetry');
    const data = JSON.parse(vscode.window.activeTextEditor!.document.getText());
    assert.equal(data.summary.turns, 1); assert.equal(data.summary.worker_requests, 2); assert.equal(data.summary.tool_calls, 1);
    assert.equal(data.turns[0].worker_stop_reason, 'completed'); assert.equal(data.turns[0].worker_model_requests, 2);
    assert.ok(data.modelRequests.every((row: { turn_id: string }) => row.turn_id === data.turns[0].turn_id));
    assert.ok(!JSON.stringify(data).includes('read fixture'));
  });
  await test('IMP-07 deterministic escalation policy and bounded handoff', async () => {
    const evidence = (kind: EscalationEvidence['kind']): EscalationEvidence => ({ kind, summary: `${kind} observed in tool result`, source: 'tool_result',
      provenance: ['production_mutation', 'destructive_operation', 'consequential_write'].includes(kind) ? 'structured_operation' : 'inspected_content',
      targetRoute: kind === 'low_complexity_invalidated' ? 'MEDIUM' : 'HIGH' });
    assert.equal(evaluateEscalation('LOW', [evidence('low_complexity_invalidated')]).toRoute, 'MEDIUM');
    assert.equal(evaluateEscalation('LOW', [evidence('security_boundary')]).toRoute, 'HIGH');
    assert.equal(evaluateEscalation('MEDIUM', [evidence('architecture_invalidated')]).toRoute, 'HIGH');
    assert.equal(evaluateEscalation('HIGH', [evidence('security_boundary')]).escalate, false);
    assert.equal(evaluateEscalation('LOW', [evidence('security_boundary')], 2).escalate, false);
    assert.equal(evaluateEscalation('MEDIUM', [evidence('low_complexity_invalidated')]).escalate, false);
    for (const kind of ['security_boundary', 'existing_data_mutation', 'production_mutation', 'consequential_write', 'destructive_operation', 'broad_contract', 'conflicting_evidence'] as const) {
      assert.equal(evaluateEscalation('MEDIUM', [evidence(kind)]).toRoute, 'HIGH');
    }
    assert.deepEqual(extractRuntimeEvidence('Production read-only logs and config inspection.'), []);
    assert.deepEqual(extractRuntimeEvidence('Another namespace typo and ordinary test failure.'), []);
    assert.equal(extractRuntimeEvidence('Views Bulk Operations and DraggableViews both control sorting.')[0]?.kind, 'architecture_invalidated');
    assert.equal(extractRuntimeEvidence('The field storage already contains records.')[0]?.kind, 'existing_data_mutation');
    assert.equal(extractRuntimeEvidence('Server-side authorization rules control it.')[0]?.kind, 'security_boundary');
    assert.deepEqual(extractRuntimeEvidence('Production config mutation requires restart.'), []);
    assert.equal(toolEvidence({ escalationEvidence: [evidence('destructive_operation')] }).length, 1);
    const wrong = validateEvidence({ kind: 'architecture_invalidated', summary: 'I need a stronger model', source: 'worker_observation', provenance: 'worker_observation', targetRoute: 'HIGH' })!;
    assert.equal(corroborateObservation(wrong, [{ provenance: 'inspected_content', text: 'one ordinary import mistake' }]), false);
    const handoff = buildHandoff('original task', 'normalized task', 'MEDIUM', 'HIGH', [evidence('architecture_invalidated')],
      ['inspected VBO'], ['sort.php'], ['tests passed'], ['sorting conflict'], ['DraggableViews controls ordering']);
    assert.deepEqual(handoff.changedTargets, ['sort.php']); assert.deepEqual(handoff.verificationResults, ['tests passed']);
    assert.equal(JSON.stringify(handoff).includes('hidden reasoning'), false);
    assert.ok(JSON.stringify(handoff).length < 3000);
  });
  await test('UI-01B provenance rejects documentation as operation evidence', async () => {
    const documentation = 'production mutation\nDROP DATABASE\ndelete users\nrestart production\nserver-side authorization rules control it';
    for (const path of ['README.md', 'AGENTS.md', 'docs/safety.md']) {
      assert.deepEqual(extractRuntimeEvidence(documentation, path), []);
    }
    assert.deepEqual(extractRuntimeEvidence('production mutation DROP DATABASE restart production', 'src/code.ts'), []);
    const attempted = (kind: EscalationEvidence['kind']): EscalationEvidence => ({ kind, summary: `Attempted ${kind} command`,
      source: 'tool_result', provenance: 'structured_operation', targetRoute: 'HIGH' });
    const fakeRead = { escalationEvidence: [attempted('production_mutation')] };
    assert.deepEqual(toolEvidence(fakeRead, 'nx_read'), []);
    assert.equal(evaluateEscalation('MEDIUM', toolEvidence(fakeRead, 'nx_execute')).toRoute, 'HIGH');
    assert.equal(evaluateEscalation('MEDIUM', [attempted('destructive_operation')]).toRoute, 'HIGH');
    assert.equal(evaluateEscalation('MEDIUM', [{ ...attempted('production_mutation'), provenance: 'inspected_content' }]).escalate, false);
    const observation = validateEvidence({ kind: 'production_mutation', summary: 'Production mutation requires restart',
      source: 'worker_observation', provenance: 'worker_observation', targetRoute: 'HIGH' })!;
    assert.equal(corroborateObservation(observation, [{ provenance: 'documentation_text', text: documentation }]), false);
    assert.equal(corroborateObservation(observation, [{ provenance: 'inspected_content', text: documentation }]), false);
    assert.equal(corroborateObservation(observation, [{ provenance: 'structured_operation', text: '{"command":"npm","args":["test"],"exitCode":0}' }]), false);
    assert.equal(evaluateEscalation('MEDIUM', [observation]).escalate, false);
    assert.equal(extractRuntimeEvidence('Server-side authorization rules control it.', 'src/access.ts')[0]?.kind, 'security_boundary');
    assert.equal(extractRuntimeEvidence('The field storage already contains records.', 'config/schema.yml')[0]?.kind, 'existing_data_mutation');
    assert.equal(extractRuntimeEvidence('Views Bulk Operations and DraggableViews both control sorting.', 'src/sort.php')[0]?.kind, 'architecture_invalidated');
  });
  await test('UI-01B known-path read-only worker stays bounded and avoids keyword escalation', async () => {
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    try {
      const dir = vscode.Uri.joinPath(root, 'ui01b-fixture'); await vscode.workspace.fs.createDirectory(dir);
      const readme = 'NX Router summary. production mutation. DROP DATABASE.\n' + 'line\n'.repeat(230);
      const agents = 'Repository instructions describe HIGH security and production mutation rules.\n';
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'README.md'), Buffer.from(readme));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'AGENTS.md'), Buffer.from(agents));
      const sequence = [
        new vscode.LanguageModelToolCallPart('instructions', productionTools.read, { path: 'ui01b-fixture/AGENTS.md' }),
        new vscode.LanguageModelToolCallPart('source-1', productionTools.read, { path: 'ui01b-fixture/README.md', startLine: 1, endLine: 200 }),
        new vscode.LanguageModelToolCallPart('source-2', productionTools.read, { path: 'ui01b-fixture/README.md', startLine: 201, endLine: 400 })
      ];
      const seen: string[] = []; let index = 0;
      const output = await runWorkerLoop({ route: 'MEDIUM', task: { userPrompt: 'อ่าน ui01b-fixture/README.md แล้วสรุป โดยยังไม่แก้ไขไฟล์' },
        normalizedTask: 'Summarize known README.md without edits.', references: [], token: token.token, stream: () => {},
        onModelRequest: async (_m, _messages, run) => run(), onToolEvent: async event => { seen.push(`${event.name}:${event.outcome}`); },
        selectModel: async () => ({ id: 'fixture', vendor: 'nx-spike', async sendRequest() {
          const part = sequence[index++] ?? new vscode.LanguageModelTextPart('README describes NX Router.');
          return { stream: (async function* () { yield part; })() };
        } } as unknown as vscode.LanguageModelChat),
        invokeTool: async (name, input, cancellation) => new ProductionTool(name as typeof productionTools[keyof typeof productionTools], new DiffContent())
          .invoke({ input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, cancellation) });
      assert.equal(output.status, 'completed'); assert.equal(output.finalRoute, 'MEDIUM'); assert.equal(output.escalations.length, 0);
      assert.equal(output.toolCalls, 3); assert.ok(seen.every(item => item === 'nx_read:success'));
      assert.deepEqual(output.consultedInstructions, ['ui01b-fixture/AGENTS.md']);
      assert.ok(workerOutcome(output).includes('Repository instructions consulted: ui01b-fixture/AGENTS.md'));
      assert.ok(workerPrompt.includes('Read explicit known workspace paths directly'));
      assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'README.md'))).toString(), readme);
    } finally { await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace); }
  });
  await test('UI-01B tool validation and one-step read recovery', async () => {
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    try {
      const dir = vscode.Uri.joinPath(root, 'ui01b-validation'); await vscode.workspace.fs.createDirectory(dir);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'long.txt'), Buffer.from('entry\n'.repeat(250)));
      const invoke = async (name: typeof productionTools[keyof typeof productionTools], input: Record<string, unknown>) => {
        const value = await new ProductionTool(name, new DiffContent()).invoke(
          { input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
        return JSON.parse((value.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
      };
      const first = await invoke(productionTools.read, { path: 'ui01b-validation/long.txt', startLine: 1, endLine: 200 });
      assert.equal(first.success, true);
      assert.equal((first.structuredData as { nextStartLine: number }).nextStartLine, 201);
      const second = await invoke(productionTools.read, { path: 'ui01b-validation/long.txt', startLine: 201, endLine: 400 });
      assert.equal(second.success, true);
      for (const include of ['{README.md,AGENTS.md}', 'README.md,AGENTS.md', '']) {
        const invalid = await invoke(productionTools.search, { query: 'entry', include });
        assert.equal(invalid.success, false); assert.match(invalid.summary, /one nonempty VS Code glob without braces, commas/);
      }
      const sequence = [
        new vscode.LanguageModelToolCallPart('bad', productionTools.read, { path: 'ui01b-validation/long.txt', startLine: 1, endLine: 201 }),
        new vscode.LanguageModelToolCallPart('fixed', productionTools.read, { path: 'ui01b-validation/long.txt', startLine: 1, endLine: 200 })
      ];
      let index = 0;
      const options = { route: 'MEDIUM' as const, task: { userPrompt: 'Read ui01b-validation/long.txt' }, normalizedTask: 'Read long file',
        references: [], token: token.token, stream: (_value: string) => {}, onModelRequest: async (_m: vscode.LanguageModelChat, _messages: vscode.LanguageModelChatMessage[], run: () => Promise<string>) => run(),
        onToolEvent: async (_event: unknown) => {},
        selectModel: async () => ({ id: 'fixture', vendor: 'nx-spike', async sendRequest() {
          const part = sequence[index++] ?? new vscode.LanguageModelTextPart('Read complete.');
          return { stream: (async function* () { yield part; })() };
        } } as unknown as vscode.LanguageModelChat),
        invokeTool: async (name: string, input: object, cancellation: vscode.CancellationToken) => new ProductionTool(name as typeof productionTools[keyof typeof productionTools], new DiffContent())
          .invoke({ input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, cancellation) };
      const recovered = await runWorkerLoop(options);
      assert.equal(recovered.stopReason, 'completed'); assert.equal(recovered.status, 'completed'); assert.deepEqual(recovered.unresolved, []);
      assert.equal(recovered.toolCalls, 2);
      const invalidCalls = [
        new vscode.LanguageModelToolCallPart('glob-1', productionTools.search, { query: 'entry', include: '{README.md,AGENTS.md}' }),
        new vscode.LanguageModelToolCallPart('glob-2', productionTools.search, { query: 'entry', include: 'README.md,AGENTS.md' })
      ];
      index = 0; sequence.splice(0, sequence.length, ...invalidCalls);
      const stopped = await runWorkerLoop(options);
      assert.equal(stopped.stopReason, 'no_progress'); assert.equal(stopped.toolCalls, 2);
    } finally { await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace); }
  });
  await test('UI-01B attempted prohibited operation escalates without executing', async () => {
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    try {
      const denied = await new ProductionTool(productionTools.execute, new DiffContent()).invoke(
        { input: { command: 'npm', args: ['run', 'deploy'] }, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
      const parsed = JSON.parse((denied.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
      assert.equal(parsed.rejected, true); assert.equal(parsed.errorCode, 'POLICY_REJECTED');
      assert.equal(toolEvidence(parsed, productionTools.execute)[0]?.kind, 'production_mutation');
      const destructive = await new ProductionTool(productionTools.execute, new DiffContent()).invoke(
        { input: { command: 'git', args: ['reset', '--hard'] }, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
      const parsedDestructive = JSON.parse((destructive.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
      assert.equal(toolEvidence(parsedDestructive, productionTools.execute)[0]?.kind, 'destructive_operation');
      const routes: string[] = [];
      const output = await runWorkerLoop({ route: 'MEDIUM', task: { userPrompt: 'Inspect deployment state' }, normalizedTask: 'Inspect deployment state', references: [],
        token: token.token, stream: () => {}, onModelRequest: async (_m, _messages, run) => run(), onToolEvent: async () => {},
        selectModel: async route => { routes.push(route); return ({ id: 'fixture', vendor: 'nx-spike', async sendRequest() {
          return { stream: (async function* () { yield route === 'MEDIUM'
            ? new vscode.LanguageModelToolCallPart('attempt', productionTools.execute, { command: 'npm', args: ['run', 'deploy'] })
            : new vscode.LanguageModelTextPart('Deployment command was blocked.'); })() };
        } } as unknown as vscode.LanguageModelChat); },
        invokeTool: async (name, input, cancellation) => new ProductionTool(name as typeof productionTools[keyof typeof productionTools], new DiffContent())
          .invoke({ input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, cancellation) });
      assert.deepEqual(routes, ['MEDIUM', 'HIGH']); assert.equal(output.finalRoute, 'HIGH');
      assert.ok(output.escalations[0].ruleIds.includes('RUNTIME_PRODUCTION_MUTATION'));
    } finally { await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace); }
  });
  await test('UI-01B path discovery and whitespace validation are unambiguous', async () => {
    const manifest = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const readSchema = manifest.contributes.languageModelTools.find((tool: { name: string }) => tool.name === 'nx_read').inputSchema;
    const searchSchema = manifest.contributes.languageModelTools.find((tool: { name: string }) => tool.name === 'nx_search').inputSchema;
    assert.equal(readSchema.properties.path.pattern, undefined);
    assert.equal(searchSchema.properties.include.pattern, '^[^{},]+$');
    assert.equal(searchSchema.properties.exclude.pattern, '^[^{},]+$');
    const dir = vscode.Uri.joinPath(root, 'ui01b-discovery'); await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'AGENTS.md'), Buffer.from('Instruction file without hash marker.'));
    const invoke = async (name: typeof productionTools.read | typeof productionTools.search, input: Record<string, unknown>) => {
      const response = await new ProductionTool(name, new DiffContent()).invoke(
        { input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
      return JSON.parse((response.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
    };
    const paths = await invoke(productionTools.search, { include: '**/AGENTS.md' });
    assert.equal(paths.success, true);
    assert.ok((paths.structuredData as { matches: Array<{ path: string }> }).matches.some(row => row.path === 'ui01b-discovery/AGENTS.md'));
    const content = await invoke(productionTools.search, { query: '#', include: 'ui01b-discovery/AGENTS.md' });
    assert.deepEqual((content.structuredData as { matches: unknown[] }).matches, []);
    const badGlob = await invoke(productionTools.search, { include: '**/AGENTS.md ' });
    assert.equal(badGlob.success, false); assert.match(badGlob.summary, /remove leading\/trailing whitespace/);
    const badPath = await invoke(productionTools.read, { path: 'ui01b-discovery/AGENTS.md ' });
    assert.equal(badPath.success, false); assert.match(badPath.summary, /remove leading\/trailing whitespace/);
  });
  await test('UI-01B known instructions and overlapping reads reuse complete turn coverage', async () => {
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    const instruction = vscode.Uri.joinPath(root, 'AGENTS.md');
    try {
      await vscode.workspace.fs.writeFile(instruction, Buffer.from('Root repository instructions.'));
      const dir = vscode.Uri.joinPath(root, 'ui01b-coverage'); await vscode.workspace.fs.createDirectory(dir);
      const target = 'ui01b-coverage/guide.txt';
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, target), Buffer.from(Array.from({ length: 240 }, (_, i) => `line ${i + 1}`).join('\n')));
      const sequence = [
        new vscode.LanguageModelToolCallPart('instructions', productionTools.read, { path: 'AGENTS.md' }),
        new vscode.LanguageModelToolCallPart('all', productionTools.read, { path: target, startLine: 1, endLine: 200 }),
        new vscode.LanguageModelToolCallPart('overlap-a', productionTools.read, { path: target, startLine: 79, endLine: 83 }),
        new vscode.LanguageModelToolCallPart('overlap-b', productionTools.read, { path: target, startLine: 73, endLine: 78 }),
        new vscode.LanguageModelToolCallPart('overlap-c', productionTools.read, { path: target, startLine: 67, endLine: 72 }),
        new vscode.LanguageModelToolCallPart('continuation', productionTools.read, { path: target, startLine: 201, endLine: 400 })
      ];
      let index = 0; const invoked: string[] = []; const events: string[] = []; let initialMessages = '';
      const output = await runWorkerLoop({ route: 'MEDIUM', task: { userPrompt: `Summarize ${target} without edits` }, normalizedTask: `Summarize ${target}`,
        references: [], token: token.token, stream: () => {},
        onModelRequest: async (_m, messages, run) => { if (!initialMessages) { initialMessages = JSON.stringify(messages); } return run(); },
        onToolEvent: async event => { events.push(`${event.name}:${event.outcome}`); },
        selectModel: async () => ({ id: 'fixture', vendor: 'nx-spike', async sendRequest() {
          const part = sequence[index++] ?? new vscode.LanguageModelTextPart('Summary complete.');
          return { stream: (async function* () { yield part; })() };
        } } as unknown as vscode.LanguageModelChat),
        invokeTool: async (name, input, cancellation) => {
          invoked.push(`${name}:${JSON.stringify(input)}`);
          return new ProductionTool(name as typeof productionTools[keyof typeof productionTools], new DiffContent()).invoke(
            { input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, cancellation);
        } });
      assert.match(initialMessages, /Root AGENTS\.md: present at AGENTS\.md/);
      assert.equal(output.status, 'completed'); assert.equal(output.toolCalls, 6);
      assert.equal(invoked.length, 3); assert.ok(invoked.every(item => item.startsWith('nx_read:')));
      assert.equal(output.actions.filter(item => item.includes('Reused')).length, 3);
      assert.ok(events.every(item => item === 'nx_read:success'));
      assert.deepEqual(output.consultedInstructions, ['AGENTS.md']);
    } finally {
      await vscode.workspace.fs.delete(instruction);
      await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace);
    }
  });
  await test('UI-01B character-capped reads report the last complete line and continuation', async () => {
    const path = 'ui01b-capped/README.md';
    const uri = vscode.Uri.joinPath(root, path);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'ui01b-capped'));
    const lines = Array.from({ length: 120 }, (_, i) => `${String(i + 1).padStart(3, '0')} ${'x'.repeat(96)}`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(lines.join('\n')));
    const invoke = async (startLine: number, endLine: number) => {
      const value = await new ProductionTool(productionTools.read, new DiffContent()).invoke(
        { input: { path, startLine, endLine }, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
      return JSON.parse((value.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
    };
    const first = await invoke(1, 120);
    const data = first.structuredData as { startLine: number; endLine: number; nextStartLine: number; content: string; rangeComplete: boolean };
    assert.equal(first.success, true); assert.equal(first.truncated, true);
    assert.equal(data.startLine, 1); assert.ok(data.endLine < 120); assert.equal(data.nextStartLine, data.endLine + 1);
    assert.equal(data.content, lines.slice(0, data.endLine).join('\n')); assert.equal(data.rangeComplete, true);
    const cache = new ReadCoverage(); cache.record(first);
    assert.ok(await cache.reuse({ path, startLine: 1, endLine: 10 }));
    assert.equal(await cache.reuse({ path, startLine: data.nextStartLine, endLine: data.nextStartLine + 5 }), undefined);
    const continuation = await invoke(data.nextStartLine, Math.min(data.nextStartLine + 39, 120));
    assert.equal((continuation.structuredData as { content: string }).content.split('\n')[0], lines[data.nextStartLine - 1]);
    const oversizedLine = vscode.Uri.joinPath(root, 'ui01b-capped/long-line.txt');
    await vscode.workspace.fs.writeFile(oversizedLine, Buffer.from(`${'z'.repeat(9000)}\nnext line`));
    const partial = await new ProductionTool(productionTools.read, new DiffContent()).invoke(
      { input: { path: 'ui01b-capped/long-line.txt', startLine: 1, endLine: 2 }, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
    const partialResult = JSON.parse((partial.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
    const partialData = partialResult.structuredData as { rangeComplete: boolean; nextStartLine?: number };
    assert.equal(partialData.rangeComplete, false); assert.equal(partialData.nextStartLine, undefined);
    assert.match(partialResult.summary, /partial line/);
  });
  await test('UI-01B incomplete or stale reads execute again; successful edit clears coverage', async () => {
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    try {
      const dir = vscode.Uri.joinPath(root, 'ui01b-freshness'); await vscode.workspace.fs.createDirectory(dir);
      const longPath = 'ui01b-freshness/long.txt', editPath = 'ui01b-freshness/edit.txt';
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, longPath), Buffer.from(Array.from({ length: 100 }, () => 'x'.repeat(100)).join('\n')));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, editPath), Buffer.from('before\n' + 'line\n'.repeat(100)));
      const invoke = async (name: string, input: object, cancellation: vscode.CancellationToken) => new ProductionTool(
        name as typeof productionTools[keyof typeof productionTools], new DiffContent(), async () => true).invoke(
          { input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, cancellation);
      const run = async (sequence: vscode.LanguageModelToolCallPart[]) => {
        let index = 0; const names: string[] = [];
        const output = await runWorkerLoop({ route: 'MEDIUM', task: { userPrompt: 'Inspect a fixture file' }, normalizedTask: 'Inspect fixture',
          references: [], token: token.token, stream: () => {}, onModelRequest: async (_m, _messages, next) => next(), onToolEvent: async () => {},
          selectModel: async () => ({ id: 'fixture', vendor: 'nx-spike', async sendRequest() {
            const part = sequence[index++] ?? new vscode.LanguageModelTextPart('Done.');
            return { stream: (async function* () { yield part; })() };
          } } as unknown as vscode.LanguageModelChat),
          invokeTool: async (name, input, cancellation) => { names.push(name); return invoke(name, input, cancellation); } });
        return { output, names };
      };
      const incomplete = await run([
        new vscode.LanguageModelToolCallPart('long', productionTools.read, { path: longPath, startLine: 1, endLine: 100 }),
        new vscode.LanguageModelToolCallPart('needed', productionTools.read, { path: longPath, startLine: 79, endLine: 83 })
      ]);
      assert.deepEqual(incomplete.names, ['nx_read', 'nx_read']);
      const changed = await run([
        new vscode.LanguageModelToolCallPart('base', productionTools.read, { path: editPath, startLine: 1, endLine: 100 }),
        new vscode.LanguageModelToolCallPart('edit', productionTools.edit, { path: editPath, edits: [{
          range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6 }, expectedText: 'before', text: 'after'
        }] }),
        new vscode.LanguageModelToolCallPart('fresh', productionTools.read, { path: editPath, startLine: 79, endLine: 83 })
      ]);
      assert.deepEqual(changed.names, ['nx_read', 'nx_edit_file', 'nx_read']);
      const first = await invoke(productionTools.read, { path: editPath, startLine: 1, endLine: 100 }, token.token);
      const cache = new ReadCoverage(); cache.record(JSON.parse((first.content[0] as vscode.LanguageModelTextPart).value));
      assert.ok(await cache.reuse({ path: editPath, startLine: 79, endLine: 83 }));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, editPath), Buffer.from('externally changed\n' + 'line\n'.repeat(100)));
      assert.equal(await cache.reuse({ path: editPath, startLine: 79, endLine: 83 }), undefined);
    } finally { await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace); }
  });
  await test('IMP-07 Extension Host production SAFE evidence switches worker in one turn', async () => {
    const folder = vscode.Uri.joinPath(root, 'escalation-fixture'); await vscode.workspace.fs.createDirectory(folder);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, 'architecture.txt'), Buffer.from('Views Bulk Operations and DraggableViews both control sorting.'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, 'high.txt'), Buffer.from('High worker inspected current state.'));
    const before = acceptanceEvents.length;
    const output: string[] = [];
    const request = { prompt: '/medium nx-escalation-fixture', references: [], command: undefined, toolInvocationToken: undefined } as unknown as vscode.ChatRequest;
    const stream = { markdown: (value: string) => { output.push(value); return stream; }, reference: () => stream } as unknown as vscode.ChatResponseStream;
    const response = await handler(request, { history: [] }, stream, token.token);
    assert.ok(!response?.errorDetails, output.join(''));
    assert.equal(parseSessionState(response?.metadata?.nxSessionState)?.route, 'HIGH');
    assert.equal((response?.metadata?.nxTurn as { providerId: string }).providerId, 'nx-spike');
    assert.equal((response?.metadata?.nxTurn as { actualRoute: string }).actualRoute, 'HIGH');
    const workersSeen = (acceptanceEvents.slice(before) as Array<{ event: string; worker?: string }>).filter(event => event.event === 'worker').map(event => event.worker);
    assert.deepEqual(workersSeen, [workers.MEDIUM, workers.HIGH, workers.HIGH]);
    await vscode.commands.executeCommand('nxRouter.exportSessionTelemetry');
    const data = JSON.parse(vscode.window.activeTextEditor!.document.getText());
    const turn = data.turns[0];
    assert.equal(turn.initial_final_route, 'MEDIUM'); assert.equal(turn.final_worker_route, 'HIGH');
    assert.equal(turn.provider_id, 'nx-spike');
    assert.equal(turn.escalation_count, 1); assert.equal(turn.escalation_completed, true);
    assert.ok(turn.escalation_rule_ids.includes('RUNTIME_ARCHITECTURE_INVALIDATED'));
    assert.deepEqual(data.modelRequests.filter((row: { role: string }) => row.role === 'worker').map((row: { route: string }) => row.route), ['MEDIUM', 'HIGH', 'HIGH']);
    assert.ok(data.modelRequests.every((row: { turn_id: string }) => row.turn_id === turn.turn_id));
    assert.equal(data.summary.tool_calls, 2);
    assert.equal(JSON.stringify(data).includes('DraggableViews'), false);
  });
  await test('IMP-07 worker control denial, direct HIGH, unavailable model and turn limits', async () => {
    const observation = { kind: 'architecture_invalidated', summary: 'Two sorting systems', targetRoute: 'HIGH' };
    const base = { task: { userPrompt: 'fix sorting' }, normalizedTask: 'fix sorting', references: [], token: token.token,
      stream: (_value: string) => {}, onModelRequest: async (_model: vscode.LanguageModelChat, _messages: vscode.LanguageModelChatMessage[], run: () => Promise<string>) => run(),
      onToolEvent: async (_event: unknown) => {} };
    const model = (sequence: Array<vscode.LanguageModelToolCallPart | vscode.LanguageModelTextPart>) => ({ id: 'fixture', vendor: 'nx-spike',
      async sendRequest() { const part = sequence.shift() ?? new vscode.LanguageModelTextPart('done'); return { stream: (async function* () { yield part; })() }; }
    } as unknown as vscode.LanguageModelChat);
    const denied = await runWorkerLoop({ ...base, route: 'MEDIUM',
      selectModel: async () => model([new vscode.LanguageModelToolCallPart('deny', 'nx_request_escalation', observation), new vscode.LanguageModelTextPart('continued')]) });
    assert.equal(denied.finalRoute, 'MEDIUM'); assert.equal(denied.escalations.length, 0); assert.equal(denied.stopReason, 'completed');
    const evidence = (kind: EscalationEvidence['kind']): EscalationEvidence => ({ kind, summary: kind, source: 'tool_result', provenance: 'inspected_content', targetRoute: 'HIGH' });
    const result = (kind: EscalationEvidence['kind']) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({
      success: true, summary: 'Observed fact', escalationEvidence: [evidence(kind)], structuredData: { path: 'fixture.txt', content: 'fact' }
    }))]);
    const routes: string[] = []; const handoffs: string[] = [];
    const chain = await runWorkerLoop({ ...base, route: 'LOW',
      selectModel: async route => { routes.push(route); return route === 'LOW' ? model([new vscode.LanguageModelToolCallPart('low', productionTools.read, { path: 'fixture.txt' })]) :
        route === 'MEDIUM' ? model([new vscode.LanguageModelToolCallPart('medium', productionTools.read, { path: 'fixture.txt' })]) :
          ({ id: 'high-fixture', vendor: 'nx-spike', async sendRequest(messages: vscode.LanguageModelChatMessage[]) { handoffs.push(JSON.stringify(messages)); return { stream: (async function* () { yield new vscode.LanguageModelTextPart('HIGH completed'); })() }; } } as unknown as vscode.LanguageModelChat); },
      invokeTool: async (_name, _input) => result(routes.at(-1) === 'LOW' ? 'low_complexity_invalidated' : 'security_boundary') });
    assert.deepEqual(routes, ['LOW', 'MEDIUM', 'HIGH']); assert.equal(chain.finalRoute, 'HIGH'); assert.equal(chain.escalations.length, 2);
    assert.equal(chain.iterations, 3); assert.equal(chain.toolCalls, 2); assert.ok(handoffs[0].includes('originalTask'));
    const unavailable = await runWorkerLoop({ ...base, route: 'MEDIUM',
      selectModel: async route => route === 'HIGH' ? undefined : model([new vscode.LanguageModelToolCallPart('read', productionTools.read, { path: 'fixture.txt' })]),
      invokeTool: async () => result('security_boundary') });
    assert.equal(unavailable.stopReason, 'escalation_unavailable'); assert.equal(unavailable.finalRoute, 'MEDIUM');
    assert.equal(unavailable.escalationCompleted, false); assert.equal(unavailable.iterations, 1);
    const limited = await runWorkerLoop({ ...base, route: 'LOW', maxIterationsPerTurn: 2,
      selectModel: async route => route === 'LOW' ? model([new vscode.LanguageModelToolCallPart('low', productionTools.read, { path: 'fixture.txt' })]) :
        model([new vscode.LanguageModelToolCallPart('medium', productionTools.read, { path: 'fixture.txt' })]),
      invokeTool: async (_name, _input) => result('low_complexity_invalidated') });
    assert.equal(limited.stopReason, 'max_iterations'); assert.equal(limited.iterations, 2);
  });
  await test('IMP-07 HIGH route still rejects dangerous execute', async () => {
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    try {
      const seen: string[] = [];
      const output = await runWorkerLoop({ route: 'HIGH', task: { userPrompt: 'run dangerous command' }, normalizedTask: 'run dangerous command', references: [], token: token.token,
        stream: () => {}, onModelRequest: async (_m, _messages, run) => run(), onToolEvent: async event => { seen.push(event.outcome); },
        selectModel: async () => ({ id: 'fixture', vendor: 'nx-spike', async sendRequest() { return { stream: (async function* () {
          yield new vscode.LanguageModelToolCallPart('danger', productionTools.execute, { command: 'git', args: ['reset', '--hard'] });
        })() }; } } as unknown as vscode.LanguageModelChat),
        invokeTool: async (name, input, cancellation) => new ProductionTool(name as typeof productionTools[keyof typeof productionTools], new DiffContent())
          .invoke({ input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, cancellation) });
      assert.equal(output.stopReason, 'tool_rejected'); assert.deepEqual(seen, ['rejected']); assert.equal(output.finalRoute, 'HIGH');
    } finally { await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace); }
  });
  await test('IMP-02 invalid JSON retries once, recovers, and falls back on second failure', async () => {
    const context = { userPrompt: 'Fix pagination' }; let calls = 0;
    const valid = JSON.stringify({ normalized_task: 'Fix pagination', intent: 'debug', complexity: 'medium', risk: 'medium', confidence: .9,
      explicit_requirements: [], inferred_context: [], unknowns: [], route: 'MEDIUM', reason: 'Normal debugging' });
    const recovered = await decideRoute(context, undefined, async (_prompt, attempt) => { calls++; return attempt ? valid : '{bad'; });
    assert.equal(calls, 2); assert.equal(recovered.retryCount, 1); assert.equal(recovered.fallback, false);
    const fallback = await decideRoute(context, undefined, async () => '{bad');
    assert.equal(fallback.finalRoute, 'MEDIUM'); assert.equal(fallback.retryCount, 1); assert.equal(fallback.fallback, true);
  });
  await test('IMP-02 manual overrides are separate from task text', async () => {
    for (const route of ['LOW','MEDIUM','HIGH'] as const) {
      const parsed = parseManualOverride(`/${route.toLowerCase()} Fix pagination`);
      assert.equal(parsed.task, 'Fix pagination'); assert.equal(parsed.override, route);
      const result = await decideRoute({ userPrompt: parsed.task }, parsed.override, async () => JSON.stringify({
        normalized_task: parsed.task, intent: 'debug', complexity: 'medium', risk: 'medium', confidence: .9,
        explicit_requirements: [], inferred_context: [], unknowns: [], route: 'MEDIUM', reason: 'Normal debugging' }));
      assert.equal(result.finalRoute, route === 'LOW' ? 'MEDIUM' : route); assert.equal(result.manualOverride, route);
    }
  });
  await test('IMP-03 deterministic risk floors rescue wrong router output', async () => {
    const mock = (task: string, route: 'LOW' | 'MEDIUM' = 'LOW', unknowns: string[] = []) => ({
      normalized_task: task, intent: 'implement' as const, complexity: 'low' as const, risk: 'low' as const, confidence: .95,
      explicit_requirements: [], inferred_context: [], unknowns, route, reason: 'Intentionally wrong fixture.'
    });
    const cases = [
      ['Change module display name from X to Y.', 'LOW', undefined, 'LOW', undefined],
      ['Fix known LINE SHOP pagination behavior.', 'LOW', undefined, 'MEDIUM', 'NONTRIVIAL_INVESTIGATION'],
      ['Implement server-side Division access permissions.', 'MEDIUM', undefined, 'HIGH', 'SECURITY_ACCESS_CHANGE'],
      ['Change Drupal field storage schema.', 'MEDIUM', { existingRecords: true }, 'HIGH', 'EXISTING_DATA_SCHEMA_MUTATION'],
      ['Design a content model for a new feature.', 'MEDIUM', undefined, 'MEDIUM', undefined],
      ['Inspect production logs to determine why deployment failed.', 'LOW', undefined, 'MEDIUM', undefined],
      ['Explain Drupal permissions and how to change them.', 'LOW', undefined, 'MEDIUM', undefined],
      ['Change production configuration and restart the service.', 'MEDIUM', undefined, 'HIGH', 'PRODUCTION_MUTATION'],
      ['Update real inventory stock.', 'MEDIUM', undefined, 'HIGH', 'CONSEQUENTIAL_WRITE'],
      ['อ่า แก้ไขหน่อย', 'LOW', undefined, 'MEDIUM', 'INSUFFICIENT_TASK_CONTEXT']
    ] as const;
    for (const [task, route, evidence, expected, rule] of cases) {
      const context = { userPrompt: task };
      const gate = evaluateRiskFloor(context, mock(task, route), evidence);
      assert.equal(gate.minimumRoute, expected, task);
      if (rule) { assert.ok(gate.triggeredRules.includes(rule), task); }
      if (task.startsWith('Design')) { assert.ok(!gate.triggeredRules.includes('EXISTING_DATA_SCHEMA_MUTATION')); }
      if (task.startsWith('Inspect')) { assert.notEqual(gate.minimumRoute, 'HIGH'); }
    }
    const withState = { userPrompt: 'ทำต่อเลย', recentTaskState: 'Debug LINE SHOP pagination behavior.' };
    const result = mock('Continue debugging LINE SHOP pagination.', 'MEDIUM');
    assert.equal(detectCriticalUnknowns(withState, result).length, 0);
    assert.equal(evaluateRiskFloor(withState, result).minimumRoute, 'MEDIUM');
  });
  await test('IMP-03 critical unknowns, bounded enrichment and reroute once', async () => {
    const fixture = (task: string, route: 'LOW' | 'MEDIUM' | 'HIGH', unknowns: string[] = []) => JSON.stringify({
      normalized_task: task, intent: 'implement', complexity: 'medium', risk: 'medium', confidence: .9,
      explicit_requirements: [], inferred_context: [], unknowns, route, reason: 'Fixture result.'
    });
    const context = { userPrompt: 'Change this Drupal field type.' };
    assert.equal(detectCriticalUnknowns(context, JSON.parse(fixture(context.userPrompt, 'MEDIUM'))).at(0)?.kind, 'existing_data');
    let calls = 0; let enrichCalls = 0;
    const decision = await decideRoute(context, undefined, async () => {
      calls++;
      return calls === 1 ? fixture(context.userPrompt, 'MEDIUM', ['Whether existing data is present']) : fixture(context.userPrompt, 'HIGH');
    }, { enrich: async input => {
      enrichCalls++;
      return { context: { ...input, enrichmentFacts: ['Target has 842 existing records.'] }, evidence: { existingRecords: true, existingDataStatus: 'present' }, inspectedFiles: 1, inspectedCharacters: 80 };
    } });
    assert.equal(enrichCalls, 1); assert.equal(calls, 2); assert.equal(decision.enrichedRoute, 'HIGH');
    assert.equal(decision.finalRoute, 'HIGH'); assert.ok(decision.riskGate.triggeredRules.includes('EXISTING_DATA_SCHEMA_MUTATION'));
    const noncritical = await decideRoute({ userPrompt: 'Change module display name from X to Y.' }, undefined,
      async () => fixture('Change module display name from X to Y.', 'LOW', ['Exact helper method name']),
      { enrich: async () => { throw Error('Should not enrich'); } });
    assert.equal(noncritical.enrichmentPerformed, false); assert.equal(noncritical.finalRoute, 'LOW');
    let inconclusiveCalls = 0;
    const inconclusive = await decideRoute(context, undefined, async () => { inconclusiveCalls++; return fixture(context.userPrompt, 'LOW', ['Whether existing data is present']); },
      { enrich: async input => ({ context: { ...input, enrichmentFacts: ['Field storage config exists; record count unknown.'] }, evidence: {}, inspectedFiles: 1, inspectedCharacters: 100 }) });
    assert.equal(inconclusiveCalls, 2); assert.equal(inconclusive.finalRoute, 'MEDIUM');
    assert.ok(inconclusive.riskGate.triggeredRules.includes('CRITICAL_CONTEXT_UNRESOLVED'));
  });
  await test('IMP-03 overrides, fallback, cancellation and VS Code enrichment adapter', async () => {
    const fixture = (task: string, route: 'LOW' | 'MEDIUM') => JSON.stringify({ normalized_task: task, intent: 'implement', complexity: 'medium', risk: 'medium', confidence: .9,
      explicit_requirements: [], inferred_context: [], unknowns: [], route, reason: 'Fixture.' });
    const permission = 'Implement server-side Division access permissions.';
    const low = await decideRoute({ userPrompt: permission }, 'LOW', async () => fixture(permission, 'LOW'));
    assert.equal(low.manualOverride, 'LOW'); assert.equal(low.finalRoute, 'HIGH');
    const schema = 'Migrate populated Drupal field storage schema.';
    const medium = await decideRoute({ userPrompt: schema }, 'MEDIUM', async () => fixture(schema, 'MEDIUM'));
    assert.equal(medium.finalRoute, 'HIGH'); assert.ok(medium.riskGate.triggeredRules.includes('EXISTING_DATA_SCHEMA_MUTATION'));
    const fallback = await decideRoute({ userPrompt: permission }, undefined, async () => '{bad');
    assert.equal(fallback.routerRequestCount, 2); assert.equal(fallback.finalRoute, 'HIGH');
    const failing = await decideRoute({ userPrompt: 'Change this Drupal field type.' }, undefined,
      async () => JSON.stringify({ normalized_task: 'Change this Drupal field type.', intent: 'implement', complexity: 'medium', risk: 'medium', confidence: .9,
        explicit_requirements: [], inferred_context: [], unknowns: ['Existing data status'], route: 'LOW', reason: 'Fixture.' }),
      { enrich: async () => { throw Error('fixture read failed'); } });
    assert.equal(failing.enrichmentFailure, 'Error'); assert.equal(failing.finalRoute, 'MEDIUM');
    const during = new vscode.CancellationTokenSource();
    let postCancelCalls = 0;
    try {
      await assert.rejects(decideRoute({ userPrompt: 'Change this Drupal field type.' }, undefined,
        async () => { postCancelCalls++; return JSON.stringify({ normalized_task: 'Change this Drupal field type.', intent: 'implement', complexity: 'medium', risk: 'medium', confidence: .9,
          explicit_requirements: [], inferred_context: [], unknowns: ['Existing data status'], route: 'MEDIUM', reason: 'Fixture.' }); },
        { cancellation: during.token, enrich: async input => { during.cancel(); return { context: input, evidence: {}, inspectedFiles: 0, inspectedCharacters: 0 }; } }),
        e => e instanceof vscode.CancellationError);
      assert.equal(postCancelCalls, 1);
    } finally { during.dispose(); }
    const source = new vscode.CancellationTokenSource(); source.cancel();
    try { await assert.rejects(decideRoute({ userPrompt: permission }, undefined, async () => fixture(permission, 'LOW'), { cancellation: source.token }), e => e instanceof vscode.CancellationError); }
    finally { source.dispose(); }
    const uri = vscode.Uri.joinPath(root, 'api-probe', 'field.storage.example.yml');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'api-probe'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from('field_storage_config: true\nexisting_records: 842\n'));
    const adapter = createVsCodeEnricher([{ value: uri } as vscode.ChatPromptReference]);
    const enriched = await adapter({ userPrompt: 'Change this Drupal field type.' }, [{ kind: 'existing_data', question: 'Records?', reason: 'Risk' }]);
    assert.equal(enriched.evidence.existingRecords, true); assert.equal(enriched.inspectedFiles, 1);
    let routed = 0;
    const integrated = await decideRoute({ userPrompt: 'Change this Drupal field type.' }, undefined, async () => { routed++; return JSON.stringify({
      normalized_task: 'Change this Drupal field type.', intent: 'implement', complexity: 'medium', risk: 'medium', confidence: .9,
      explicit_requirements: [], inferred_context: [], unknowns: ['Existing data status'], route: 'MEDIUM', reason: 'Fixture.' });
    }, { enrich: adapter });
    assert.equal(routed, 2); assert.equal(integrated.finalRoute, 'HIGH');
    assert.ok(enriched.inspectedCharacters <= 4000);
    await vscode.workspace.fs.delete(uri);
  });
  await test('IMP-02 API-equivalent cost boundary uses configured rates only', async () => {
    assert.equal(estimateCost('unknown-model', 1000, 500), undefined);
    pricing['fixture-priced-model'] = { inputPerMillion: 2, outputPerMillion: 4 };
    try { assert.equal(estimateCost('fixture-priced-model', 1000, 500), 0.004); }
    finally { delete pricing['fixture-priced-model']; }
  });
  await test('IMP-02 telemetry disabled/enabled and metadata-only session export', async () => {
    const extension = vscode.extensions.getExtension('nx-router.nx-router')!;
    const dir = vscode.Uri.joinPath(root, 'telemetry-test');
    const telemetry = new Telemetry({ ...extension.exports, globalStorageUri: dir } as vscode.ExtensionContext);
    const setting = vscode.workspace.getConfiguration('nxRouter.telemetry');
    const original = setting.get<boolean>('enabled', true);
    const sessionId = newId(); const turnId = newId();
    try {
      await setting.update('enabled', false, vscode.ConfigurationTarget.Workspace);
      await telemetry.startSession(sessionId);
      assert.equal((await telemetry.export() as any).sessions.length, 0);
      await setting.update('enabled', true, vscode.ConfigurationTarget.Workspace);
      await telemetry.startSession(sessionId);
      await telemetry.recordModel({ session_id: sessionId, turn_id: turnId, request_id: newId(), role: 'router', provider: 'openai',
        model: 'gpt-6-luna', effort: 'low', observed_input_tokens: 10, observed_output_tokens: 5, duration_ms: 20, success: true, at: new Date().toISOString() });
      await telemetry.recordTurn({ session_id: sessionId, turn_id: turnId, initial_route: 'MEDIUM', final_route: 'MEDIUM', confidence: .9,
        retry_count: 0, router_request_count: 1, critical_unknown_count: 0, enrichment_performed: false, risk_floor: 'MEDIUM', risk_gate_rules: ['NONTRIVIAL_INVESTIGATION'],
        duration_ms: 25, status: 'completed', at: new Date().toISOString() });
      const data = await telemetry.export(sessionId) as any;
      assert.equal(data.summary.router_requests, 1); assert.equal(data.summary.turns, 1);
      assert.equal(data.summary.observed_input_tokens, 10);
      assert.equal(data.turns[0].router_request_count, 1); assert.deepEqual(data.turns[0].risk_gate_rules, ['NONTRIVIAL_INVESTIGATION']);
      assert.ok(!JSON.stringify(data).includes('Fix pagination'));
      await telemetry.clear(sessionId);
      assert.equal((await telemetry.export(sessionId) as any).summary.turns, 0);
    } finally { await setting.update('enabled', original, vscode.ConfigurationTarget.Workspace); }
  });
  await test('IMP-08 telemetry scopes, route counts and retention cleanup', async () => {
    const extension = vscode.extensions.getExtension('nx-router.nx-router')!;
    const dir = vscode.Uri.joinPath(root, 'telemetry-imp08');
    const local = new Telemetry({ ...extension.exports, globalStorageUri: dir } as vscode.ExtensionContext);
    const recent = new Date().toISOString(), old = new Date(Date.now() - 100 * 86400000).toISOString();
    const current = newId(), stale = newId(), foreign = newId();
    await local.startSession(current);
    await local.append('sessions', { session_id: stale, workspace_id: local.workspaceId, at: old });
    await local.append('sessions', { session_id: foreign, workspace_id: 'other-workspace', at: recent });
    await local.recordModel({ session_id: current, turn_id: newId(), request_id: newId(), role: 'worker', provider: 'openai', model: 'gpt-6-sol', route: 'MEDIUM',
      duration_ms: 10, success: true, at: recent });
    await local.recordTurn({ session_id: current, turn_id: newId(), initial_route: 'MEDIUM', final_route: 'HIGH', confidence: 1, retry_count: 0,
      duration_ms: 10, status: 'completed', escalation_count: 1, at: recent });
    const before = await local.export(current) as any;
    assert.equal(before.summary.medium_worker_requests, 1); assert.equal(before.summary.escalations, 1);
    assert.equal(before.summary.estimated_api_equivalent_cost_usd, null);
    await local.applyRetention();
    assert.equal((await local.export(stale) as any).summary.sessions, 0);
    await local.clear(undefined, true);
    assert.equal((await local.export(current) as any).summary.turns, 0);
    assert.equal((await local.export(foreign) as any).summary.sessions, 1);
    await local.clear();
    assert.equal((await local.export() as any).summary.sessions, 0);
  });
  await test('workspace.fs create/read/copy/rename/delete and findFiles', async () => {
    const directory = vscode.Uri.joinPath(root, 'api-probe');
    await vscode.workspace.fs.createDirectory(directory);
    const a = vscode.Uri.joinPath(directory, 'a.txt');
    const b = vscode.Uri.joinPath(directory, 'b.txt');
    const c = vscode.Uri.joinPath(directory, 'c.txt');
    await vscode.workspace.fs.writeFile(a, Buffer.from('before\n'));
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(a)).toString(), 'before\n');
    await vscode.workspace.fs.copy(a, b, { overwrite: false });
    await vscode.workspace.fs.rename(b, c, { overwrite: false });
    assert.equal((await vscode.workspace.findFiles('api-probe/*.txt')).length, 2);
    await vscode.workspace.fs.delete(c);
    await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(c)));
  });
  await test('WorkspaceEdit create/edit/rename/delete and TextDocument save', async () => {
    const a = vscode.Uri.joinPath(root, 'api-probe', 'edit.txt');
    const b = vscode.Uri.joinPath(root, 'api-probe', 'moved.txt');
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(a); edit.insert(a, new vscode.Position(0, 0), 'edited\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const document = await vscode.workspace.openTextDocument(a);
    assert.equal(document.getText(), 'edited\n'); assert.equal(await document.save(), true);
    const rename = new vscode.WorkspaceEdit(); rename.renameFile(a, b);
    assert.equal(await vscode.workspace.applyEdit(rename), true);
    const remove = new vscode.WorkspaceEdit(); remove.deleteFile(b);
    assert.equal(await vscode.workspace.applyEdit(remove), true);
  });
  await test('Native diff editor opens', async () => {
    const left = vscode.Uri.joinPath(root, 'api-probe', 'a.txt');
    const right = vscode.Uri.joinPath(root, 'api-probe', 'right.txt');
    await vscode.workspace.fs.writeFile(right, Buffer.from('after\n'));
    await vscode.commands.executeCommand('vscode.diff', left, right, 'NX API test diff');
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextDiff)));
  });
  await test('Diagnostics collection publish/read', async () => {
    const collection = vscode.languages.createDiagnosticCollection('nx-spike-test');
    const uri = vscode.Uri.joinPath(root, 'api-probe', 'a.txt');
    try {
      collection.set(uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'Synthetic spike diagnostic')]);
      assert.ok(vscode.languages.getDiagnostics(uri).some(d => d.message === 'Synthetic spike diagnostic'));
    } finally { collection.dispose(); }
  });
  await test('Registered native tool invocation (read, no chat token)', async () => {
    assert.ok(vscode.lm.tools.find(t => t.name === 'nx_spike_workspace'));
    const result = await vscode.lm.invokeTool('nx_spike_workspace', { input: { operation: 'read' }, toolInvocationToken: undefined }, token.token);
    assert.ok(result.content.some(p => p instanceof vscode.LanguageModelTextPart && p.value.includes('does not exist')));
  });
  await test('Model provider discovery, LOW/MEDIUM/HIGH selection, streaming and tool roundtrip', async () => {
    for (const id of Object.values(workers)) {
      const [model] = await vscode.lm.selectChatModels({ vendor: 'nx-spike', id });
      assert.ok(model, `No model for ${id}`);
      const messages = [vscode.LanguageModelChatMessage.User('read')];
      const response = await model.sendRequest(messages, { tools: vscode.lm.tools.filter(t => t.name === 'nx_spike_workspace') }, token.token);
      let text = ''; let call: vscode.LanguageModelToolCallPart | undefined;
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
        if (part instanceof vscode.LanguageModelToolCallPart) { call = part; }
      }
      assert.match(text, /scripted fixture/); assert.ok(call);
      const result = await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: undefined }, token.token);
      messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
      messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, result.content)]));
      const response2 = await model.sendRequest(messages, {}, token.token);
      let final = ''; for await (const chunk of response2.text) { final += chunk; }
      assert.match(final, /Tool result received/);
    }
  });
  await test('IMP-01B virtual provider switches workers with history and tool-result continuation (API caller, not Local)', async () => {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'nx-spike', id: autoId });
    assert.ok(model);
    const messages = [vscode.LanguageModelChatMessage.User('/low read\nAttached fixture: ATTACHMENT_SENTINEL')];
    const tools = vscode.lm.tools.filter(t => Object.values(isolatedTools).includes(t.name as typeof isolatedTools[keyof typeof isolatedTools]));
    for (const [turn, worker] of [[0, workers.LOW], [1, workers.HIGH]] as const) {
      if (turn) { messages.push(vscode.LanguageModelChatMessage.User('/high read')); }
      const response = await model.sendRequest(messages, { tools }, token.token);
      let call: vscode.LanguageModelToolCallPart | undefined; let text = '';
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
        if (part instanceof vscode.LanguageModelToolCallPart) { call = part; }
      }
      assert.ok(text.includes(worker)); assert.ok(call); assert.equal(call.name, isolatedTools.read);
      const result = await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: undefined }, token.token);
      messages.push(vscode.LanguageModelChatMessage.Assistant([call]));
      messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, result.content)]));
      const continued = await model.sendRequest(messages, { tools }, token.token);
      let final = ''; for await (const chunk of continued.text) { final += chunk; }
      assert.ok(final.includes(worker)); assert.match(final, /Tool result received/);
      const observed = acceptanceEvents.at(-1) as { worker: string; attachmentSentinel: boolean; resultCallIds: string[] };
      assert.equal(observed.worker, worker); assert.equal(observed.attachmentSentinel, true); assert.ok(observed.resultCallIds.includes(call.callId));
      messages.push(vscode.LanguageModelChatMessage.Assistant(final));
    }
  });
  await test('IMP-01B isolated SAFE cannot be redirected to WRITE or DANGEROUS', async () => {
    await assert.rejects(Promise.resolve(vscode.lm.invokeTool(isolatedTools.read,
      { input: { operation: 'dangerous' }, toolInvocationToken: undefined }, token.token)));
  });
  await test('IMP-01B model cancellation reaches provider while streaming', async () => {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'nx-spike', id: autoId });
    const source = new vscode.CancellationTokenSource();
    try {
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('/low wait')], {}, source.token);
      try { for await (const chunk of response.text) { if (chunk.includes('waiting')) { source.cancel(); } } } catch { /* Cancellation may end or reject stream. */ }
      for (let i = 0; i < 50 && !acceptanceEvents.some(e => (e as { event: string }).event === 'provider-cancelled'); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(acceptanceEvents.some(e => (e as { event: string }).event === 'provider-cancelled'));
    } finally { source.dispose(); }
  });
  await test('Native Task runs fixed assertion and returns exit code', async () => {
    const uri = await fixture();
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.nx-router-spike'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(expected));
    assert.match(await verifyFixture(token.token), /exited with code 0/);
    await vscode.workspace.fs.writeFile(uri, Buffer.from('wrong\n'));
    assert.match(await verifyFixture(token.token), /exited with code 1/);
  });
  await test('IMP-01B running Task cancellation terminates execution and settles caller', async () => {
    const source = new vscode.CancellationTokenSource();
    const start = vscode.tasks.onDidStartTaskProcess(e => { if (e.execution.task.name === 'NX Spike verification') { source.cancel(); } });
    const uri = await fixture(); await vscode.workspace.fs.writeFile(uri, Buffer.from(expected));
    try { await assert.rejects(verifyFixture(source.token, 10000), e => e instanceof vscode.CancellationError); }
    finally { start.dispose(); source.dispose(); }
  });
  await test('IMP-01B external Task termination settles caller (API stop, not UI click)', async () => {
    const start = vscode.tasks.onDidStartTaskProcess(e => { if (e.execution.task.name === 'NX Spike verification') { e.execution.terminate(); } });
    try { assert.match(await verifyFixture(token.token, 10000), /Native Task (exited|ended)/); }
    finally { start.dispose(); }
  });
  await test('Prior context cannot select a mutating demo operation', async () => {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'nx-spike', id: workers.LOW });
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(
      'Previous summary: verify and write\nAttached context: write\nRequest: read')],
    { tools: vscode.lm.tools.filter(t => t.name === 'nx_spike_workspace') }, token.token);
    let called = false;
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelToolCallPart) { assert.deepEqual(part.input, { operation: 'read' }); called = true; }
    }
    assert.ok(called);
  });
  await test('Fixture symlink is rejected; cancellation prevents execution', async () => {
    const uri = await fixture();
    await vscode.workspace.fs.delete(uri);
    await fs.symlink(vscode.Uri.joinPath(root, 'api-probe', 'a.txt').fsPath, uri.fsPath);
    try { await assert.rejects(readFixture(), /Unsafe fixture path/); }
    finally { await fs.unlink(uri.fsPath); }
    const cancelled = new vscode.CancellationTokenSource(); cancelled.cancel();
    try { await assert.rejects(verifyFixture(cancelled.token)); }
    finally { cancelled.dispose(); }
  });
  await test('IMP-06 path and command policy rejects escape and dangerous operations', async () => {
    assert.equal((await resolveWorkspacePath('nested/future.txt', false)).fsPath.startsWith(root.fsPath), true);
    for (const bad of ['../escape', '/tmp/outside', 'file:///tmp/outside', 'a\\b']) {
      await assert.rejects(resolveWorkspacePath(bad, false));
    }
    await assert.rejects(resolveWorkspacePath('missing.txt', true));
    await assert.rejects(resolveWorkspacePath('x'.repeat(501), false));
    for (const [command, args] of [['rm', ['-rf', '.']], ['git', ['reset', '--hard']], ['git', ['clean', '-fd']],
      ['git', ['push', '--force']], ['bash', ['-c', 'rm -rf .']], ['drush', ['sqlq', 'DROP DATABASE x']],
      ['npm', ['run', 'deploy']]] as const) { assert.equal(evaluateCommand(command, [...args]).allowed, false); }
    assert.equal(evaluateCommand('npm', ['test']).allowed, true);
    assert.equal(routeAllowsTool('HIGH', 'nx_spike_dangerous'), false);
    assert.equal(routeAllowsTool('LOW', productionTools.execute), false);
  });
  await test('IMP-06 production tools read, search, edit, execute in isolated host workspace', async () => {
    const dir = vscode.Uri.joinPath(root, 'production-fixture'); await vscode.workspace.fs.createDirectory(dir);
    const approved = async () => true;
    const tool = (name: typeof productionTools[keyof typeof productionTools], approval?: typeof approved) => new ProductionTool(name, new DiffContent(), approval);
    const invoke = async (name: typeof productionTools[keyof typeof productionTools], input: Record<string, unknown>, approval?: typeof approved): Promise<NxToolResult> => {
      const output = await tool(name, approval).invoke({ input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
      return JSON.parse((output.content[0] as vscode.LanguageModelTextPart).value);
    };
    const target = 'production-fixture/example.txt';
    assert.equal((await invoke(productionTools.create, { path: target, content: 'alpha\nbeta\n' }, approved)).success, true);
    const registeredRead = await vscode.lm.invokeTool(productionTools.read, { input: { path: target }, toolInvocationToken: undefined }, token.token);
    assert.equal((JSON.parse((registeredRead.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult).success, true);
    assert.equal(((await invoke(productionTools.read, { path: target, startLine: 2, endLine: 2 })).structuredData as { content: string })?.content, 'beta');
    const found = await invoke(productionTools.search, { query: 'alpha', include: 'production-fixture/**/*.txt' });
    assert.equal(found.success, true); assert.ok((found.structuredData as any).matches.some((m: any) => m.path === target));
    const change = { range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 5 }, expectedText: 'alpha', text: 'gamma' };
    assert.equal((await invoke(productionTools.edit, { path: target, edits: [change] }, approved)).success, true);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, target))).toString(), 'gamma\nbeta\n');
    const rejected = await invoke(productionTools.edit, { path: target, edits: [{ ...change, expectedText: 'gamma' }] }, async () => false);
    assert.equal(rejected.rejected, true);
    assert.equal((await invoke(productionTools.copy, { source: target, destination: 'production-fixture/copied.txt' }, approved)).success, true);
    assert.equal((await invoke(productionTools.move, { source: 'production-fixture/copied.txt', destination: 'production-fixture/moved.txt' }, approved)).success, true);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'package.json'), Buffer.from(JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } })));
    const passed = await invoke(productionTools.execute, { command: 'npm', args: ['test'], cwd: 'production-fixture' });
    assert.equal(passed.success, true); assert.equal((passed.structuredData as { exitCode: number }).exitCode, 0);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'package.json'), Buffer.from(JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(3)"' } })));
    const failed = await invoke(productionTools.execute, { command: 'npm', args: ['test'], cwd: 'production-fixture' });
    assert.equal(failed.success, false); assert.equal((failed.structuredData as { exitCode: number }).exitCode, 3);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'package.json'), Buffer.from(JSON.stringify({ private: true, scripts: { test: 'node -e "setTimeout(() => {}, 10000)"' } })));
    const timedOut = await invoke(productionTools.execute, { command: 'npm', args: ['test'], cwd: 'production-fixture', timeoutMs: 1000 });
    assert.equal(timedOut.success, false); assert.equal(timedOut.errorCode, 'TIMEOUT');
    const source = new vscode.CancellationTokenSource();
    try {
      const running = tool(productionTools.execute).invoke({ input: { command: 'npm', args: ['test'], cwd: 'production-fixture' }, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, source.token);
      setTimeout(() => source.cancel(), 150);
      const cancelled = JSON.parse(((await running).content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
      assert.equal(cancelled.cancelled, true);
    } finally { source.dispose(); }
    assert.equal((await invoke(productionTools.execute, { command: 'git', args: ['diff', '--check'] })).success, false);
    const denied = await invoke(productionTools.execute, { command: 'bash', args: ['-c', 'echo hi'] });
    assert.equal(denied.rejected, true);
    const git = await invoke(productionTools.gitStatus, {}); assert.equal(git.success, false);
    const diagnostic = await invoke(productionTools.diagnostics, { path: target }); assert.equal(diagnostic.success, true);
    const binary = 'production-fixture/binary.dat';
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, binary), Buffer.from([65, 0, 66]));
    assert.equal((await invoke(productionTools.read, { path: binary })).success, false);
    const large = 'production-fixture/large.txt';
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, large), Buffer.from('x'.repeat(70000)));
    assert.equal((await invoke(productionTools.read, { path: large })).truncated, true);
    for (let i = 0; i < 32; i++) { await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, `match-${i}.txt`), Buffer.from('MATCH_SENTINEL\n')); }
    const many = await invoke(productionTools.search, { query: 'MATCH_SENTINEL', include: 'production-fixture/match-*.txt' });
    assert.equal(many.truncated, true); assert.equal((many.structuredData as { matches: unknown[] }).matches.length, 30);
    assert.equal((await invoke(productionTools.create, { path: target, content: 'overwrite' }, approved)).success, false);
    assert.equal((await invoke(productionTools.copy, { source: target, destination: 'production-fixture/moved.txt' }, approved)).success, false);
    assert.equal((await invoke(productionTools.edit, { path: target, edits: [change] }, approved)).success, false);
    const external = await fs.mkdtemp('/tmp/nx-imp06-symlink-');
    await fs.symlink(external, vscode.Uri.joinPath(dir, 'outside').fsPath);
    try { assert.equal((await invoke(productionTools.create, { path: 'production-fixture/outside/escape.txt', content: 'no' }, approved)).success, false); }
    finally { await fs.rm(vscode.Uri.joinPath(dir, 'outside').fsPath); await fs.rm(external, { recursive: true }); }
  });
  await test('IMP-06 worker uses production read, edit and verified execute', async () => {
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    try {
      const target = 'production-fixture/worker.txt';
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, target), Buffer.from('before\n'));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, 'production-fixture/package.json'), Buffer.from(JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } })));
      const sequence = [
        new vscode.LanguageModelToolCallPart('read', productionTools.read, { path: target }),
        new vscode.LanguageModelToolCallPart('edit', productionTools.edit, { path: target, edits: [{ range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 6 }, expectedText: 'before', text: 'after' }] }),
        new vscode.LanguageModelToolCallPart('verify', productionTools.execute, { command: 'npm', args: ['test'], cwd: 'production-fixture' })
      ];
      let index = 0; const events: string[] = [];
      const output = await runWorkerLoop({ route: 'MEDIUM', task: { userPrompt: 'edit worker fixture and test' }, normalizedTask: 'edit worker fixture and test', references: [], token: token.token,
        stream: () => {}, onModelRequest: async (_m, _messages, run) => run(), onToolEvent: async event => { events.push(`${event.name}:${event.outcome}`); },
        selectModel: async () => ({ id: 'fixture', vendor: 'nx-spike', async sendRequest() { const part = sequence[index++] ?? new vscode.LanguageModelTextPart('Verified change.'); return { stream: (async function* () { yield part; })() }; } } as unknown as vscode.LanguageModelChat),
        invokeTool: async (name, input, cancellation) => new ProductionTool(name as typeof productionTools[keyof typeof productionTools], new DiffContent(), async () => true)
          .invoke({ input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, cancellation) });
      assert.equal(output.status, 'completed'); assert.equal(output.toolCalls, 3); assert.deepEqual(events, ['nx_read:success', 'nx_edit_file:success', 'nx_execute:success']);
      assert.deepEqual(output.changedTargets, [target]); assert.equal(output.verification.length, 1);
      assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, target))).toString(), 'after\n');
    } finally { await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace); }
  });
  await test('IMP-06 git status and diff remain bounded and read-only', async () => {
    const dir = root;
    const git = (...args: string[]) => execFileSync('git', ['-C', dir.fsPath, ...args], { stdio: 'ignore' });
    git('init');
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'a.txt'), Buffer.from('first\n'));
    git('add', 'a.txt'); git('-c', 'user.name=NX Test', '-c', 'user.email=nx@example.invalid', 'commit', '-m', 'fixture');
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'a.txt'), Buffer.from('second\n'));
    const invoke = async (name: typeof productionTools.gitStatus | typeof productionTools.gitDiff, input: Record<string, unknown>) => {
      const output = await new ProductionTool(name, new DiffContent()).invoke({ input, toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token.token);
      return JSON.parse((output.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
    };
    const status = await invoke(productionTools.gitStatus, {}); assert.equal(status.success, true);
    assert.match((status.structuredData as { stdout: string }).stdout, /a.txt/);
    const diff = await invoke(productionTools.gitDiff, {}); assert.equal(diff.success, true);
    assert.match((diff.structuredData as { stdout: string }).stdout, /second/);
    git('add', 'a.txt');
    const staged = await invoke(productionTools.gitDiff, { cached: true }); assert.equal(staged.success, true);
    assert.match((staged.structuredData as { stdout: string }).stdout, /second/);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'large-diff.txt'), Buffer.from('x'.repeat(18000) + '\n'));
    git('add', 'large-diff.txt');
    assert.equal((await invoke(productionTools.gitDiff, { cached: true })).truncated, true);
  });
  token.dispose();
  const output = process.env.NX_SPIKE_RESULTS!;
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ vscode: vscode.version, platform: process.platform, results, acceptanceEvents }, null, 2));
  console.log(JSON.stringify(results, null, 2));
  assert.equal(results.filter(r => r.status === 'failed').length, 0, `See ${output}`);
}
