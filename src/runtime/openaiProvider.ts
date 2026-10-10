import * as vscode from 'vscode';
import { Route } from '../route';
import { NxModelSelection, NxProvider, NxProviderProfile } from './providers';
import { OpenAIAuth, OpenAIStatus } from './openaiAuth';
import { OpenAIStreamFailure, readOpenAIResponseStream } from './openaiStream';
import { AutoConfiguration, MappingRole, validateAutoMapping } from './autoConfiguration';

const api = 'https://api.openai.com/v1';
const mappingKey = 'openai.mapping.v1.';
export interface OpenAIModel { id: string; name: string; effortOptions: readonly string[]; availability: 'available' }
export interface OpenAITestResult { connection: 'OK' | 'FAILED'; modelDiscovery: 'OK' | 'FAILED'; inference: 'OK' | 'FAILED'; model?: string; durationMs: number; message?: string }
export interface OpenAIConfiguration {
  providerId: 'openai'; profileId?: string; state: OpenAIStatus['state']; modelMappingComplete: boolean;
  auto: AutoConfiguration;
  models?: readonly OpenAIModel[];
  mappings: Record<MappingRole, { modelId?: string; effort: string; available: boolean; validity: 'unconfigured' | 'available' | 'unavailable' }>;
}
type Mapping = { router?: NxModelSelection; tiers: Partial<Record<Route, NxModelSelection>> };
const settingKeys: Record<MappingRole, string> = { Router: 'routerModel', LOW: 'lowModel', MEDIUM: 'mediumModel', HIGH: 'highModel' };
const settingsSection = 'nxRouter.providers.openai';

interface ApiFailure { code?: string; param?: string }
const safeDiagnostic = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;
function safeError(status: number, failure: ApiFailure = {}): Error {
  const { code, param } = failure;
  if (status === 401 || code === 'subscription_sharing_invalid_user') { return new Error('OpenAI connection needs reauthentication.'); }
  if (code === 'subscription_sharing_usage_limit_exceeded') { return new Error('ChatGPT plan usage limit reached. Check ChatGPT Settings → Usage.'); }
  if (code === 'subscription_sharing_usage_unavailable' || status === 503) { return new Error('ChatGPT plan usage is temporarily unavailable. Retry later.'); }
  if (status === 403) { return new Error('ChatGPT plan permission or region is unavailable for this connection.'); }
  if (code === 'subscription_sharing_unsupported_capability') { return new Error('Selected OpenAI model does not support this request capability.'); }
  const detail = [`HTTP ${Number.isInteger(status) && status >= 100 && status <= 599 ? status : 'error'}`,
    ...(code ? [`code ${code}`] : []), ...(param ? [`field ${param}`] : [])].join('; ');
  return new Error(`OpenAI request failed (${detail}). Check the connection, model, and tool schema.`);
}
function responseError(payload: unknown): ApiFailure {
  if (!payload || typeof payload !== 'object') { return {}; }
  const value = payload as { error?: { code?: unknown; type?: unknown; param?: unknown }; response?: { error?: { code?: unknown; type?: unknown; param?: unknown } } };
  const error = value.error ?? value.response?.error;
  return { code: safeDiagnostic(error?.code ?? error?.type, /^[A-Za-z0-9_.-]{1,80}$/),
    param: safeDiagnostic(error?.param, /^[A-Za-z0-9_.\[\]-]{1,120}$/) };
}

export class OpenAIProvider implements NxProvider {
  private readonly catalogChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCatalog = this.catalogChanged.event;
  dispose(): void { this.catalogChanged.dispose(); }
  readonly id = 'openai';
  readonly label = 'OpenAI / ChatGPT';
  private models: OpenAIModel[] = [];
  private modelProfileId?: string;
  private reasoningByCall = new Map<string, unknown[]>();
  constructor(readonly auth: OpenAIAuth, private readonly state: vscode.Memento, private readonly fetcher: typeof fetch = fetch) {}
  async connectionStatus(): Promise<'connected' | 'disconnected' | 'unavailable'> {
    const status = await this.auth.status();
    return status.state === 'connected' ? 'connected' : status.state === 'not_connected' ? 'disconnected' : 'unavailable';
  }
  private userModel(role: MappingRole): string {
    const inspected = vscode.workspace.getConfiguration(settingsSection).inspect<string>(settingKeys[role]);
    // Only the User value is authoritative. Workspace and folder values are ignored.
    return typeof inspected?.globalValue === 'string' ? inspected.globalValue.trim() : '';
  }
  private async writeUserModel(role: MappingRole, modelId: string): Promise<void> {
    await vscode.workspace.getConfiguration(settingsSection).update(settingKeys[role], modelId, vscode.ConfigurationTarget.Global);
  }
  async migrateLegacyMapping(models: readonly OpenAIModel[]): Promise<boolean> {
    const profileId = this.auth.selectedProfile()?.id;
    if (!profileId || (['Router', 'LOW', 'MEDIUM', 'HIGH'] as const).some(role => this.userModel(role))) { return false; }
    const legacy = this.state.get<Mapping>(mappingKey + profileId);
    const values = [legacy?.router?.modelId, legacy?.tiers?.LOW?.modelId, legacy?.tiers?.MEDIUM?.modelId, legacy?.tiers?.HIGH?.modelId];
    const available = new Set(models.map(model => model.id));
    if (values.some(value => !value || !available.has(value))) { return false; }
    for (const [index, role] of (['Router', 'LOW', 'MEDIUM', 'HIGH'] as const).entries()) {
      await this.writeUserModel(role, values[index]!);
    }
    await this.state.update(mappingKey + profileId, undefined);
    return true;
  }
  async status(): Promise<OpenAIStatus> {
    const profile = this.auth.selectedProfile();
    if (profile && (await this.auth.status()).state === 'connected') {
      try { await this.auth.accessToken(); } catch { /* Auth exposes a sanitized recovery state. */ }
    }
    if (profile && this.modelProfileId !== profile.id && (await this.auth.status()).state === 'connected') {
      try { await this.listModels(); } catch { /* A connection can still exist when catalog refresh is offline. */ }
    }
    const complete = !!profile && this.modelProfileId === profile.id &&
      validateAutoMapping(this.profile(), this.models.map(model => model.id), true).available;
    return this.auth.status(complete);
  }
  profile(): NxProviderProfile {
    return { providerId: this.id, auto: { router: { modelId: this.userModel('Router') }, tiers: {
      LOW: { modelId: this.userModel('LOW') }, MEDIUM: { modelId: this.userModel('MEDIUM') }, HIGH: { modelId: this.userModel('HIGH') }
    } } };
  }
  async configuration(): Promise<OpenAIConfiguration> {
    const status = await this.status();
    const profile = this.profile();
    const available = new Set(this.modelProfileId === status.profileId ? this.models.map(model => model.id) : []);
    const auto = validateAutoMapping(profile, [...available], status.state === 'connected');
    const mappings = {} as OpenAIConfiguration['mappings'];
    for (const role of ['Router', 'LOW', 'MEDIUM', 'HIGH'] as const) {
      const item = auto.mappings[role];
      mappings[role] = { ...item, effort: 'provider default', available: item.valid };
    }
    return { providerId: 'openai', profileId: status.profileId, state: status.state, modelMappingComplete: auto.available, auto, mappings,
      models: status.state === 'connected' && this.modelProfileId === status.profileId ? this.models : [] };
  }
  async autoAvailability(): Promise<AutoConfiguration> { return (await this.configuration()).auto; }
  async setMapping(role: 'Router' | Route, selection: NxModelSelection): Promise<void> {
    const profile = this.auth.selectedProfile();
    if (!profile) { throw new Error('Connect OpenAI before configuring models.'); }
    const models = await this.listModels();
    const model = models.find(item => item.id === selection.modelId);
    if (!model) { throw new Error('Selected model is not available for this OpenAI account.'); }
    if (selection.effort && !model.effortOptions.includes(selection.effort)) { throw new Error('Selected effort is not confirmed for this model. Use provider default.'); }
    await this.writeUserModel(role, selection.modelId);
  }
  async listModels(): Promise<readonly OpenAIModel[]> {
    const profile = this.auth.selectedProfile();
    if (!profile) { throw new Error('Connect OpenAI before discovering models.'); }
    const token = await this.auth.accessToken();
    let response: Response;
    try { response = await this.fetcher(`${api}/models`, { headers: { Authorization: `Bearer ${token}` } }); }
    catch { throw new Error('OpenAI model discovery is temporarily unavailable.'); }
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) { const failure = responseError(payload); this.auth.noteApiFailure(response.status, failure.code); throw safeError(response.status, failure); }
    const entries = payload && typeof payload === 'object' ? (payload as { models?: unknown }).models : undefined;
    if (!Array.isArray(entries)) { throw new Error('OpenAI returned an invalid model catalog.'); }
    const models: OpenAIModel[] = [];
    for (const item of entries) {
      if (!item || typeof item !== 'object') { continue; }
      const raw = item as { slug?: unknown; display_name?: unknown; visibility?: unknown };
      if (raw.visibility !== 'list' || typeof raw.slug !== 'string' || !raw.slug || typeof raw.display_name !== 'string') { continue; }
      models.push({ id: raw.slug, name: raw.display_name, effortOptions: [], availability: 'available' });
    }
    this.models = models;
    this.modelProfileId = profile.id;
    this.auth.noteApiSuccess();
    await this.migrateLegacyMapping(models);
    this.catalogChanged.fire();
    return models;
  }
  async refreshConfiguration(): Promise<OpenAIConfiguration> {
    const connection = (await this.auth.status()).state;
    if (this.auth.selectedProfile() && ['connected', 'usage_unavailable', 'error'].includes(connection)) {
      try { await this.listModels(); } catch { this.models = []; this.modelProfileId = undefined; }
    } else { this.models = []; this.modelProfileId = undefined; }
    return this.configuration();
  }
  async resolveModel(selection: NxModelSelection): Promise<vscode.LanguageModelChat | undefined> {
    if (!selection.modelId) { return undefined; }
    if ((await this.auth.status()).state !== 'connected') { return undefined; }
    const profile = this.auth.selectedProfile();
    if (!profile) { return undefined; }
    const models = this.modelProfileId === profile.id ? this.models : await this.listModels();
    const model = models.find(item => item.id === selection.modelId);
    if (!model) { return undefined; }
    if (selection.effort && !model.effortOptions.includes(selection.effort)) { throw new Error('Selected effort is not confirmed for this model.'); }
    return this.chatModel(model);
  }
  private chatModel(model: OpenAIModel): vscode.LanguageModelChat {
    return { id: model.id, name: model.name, vendor: this.id, family: model.id, version: '1', maxInputTokens: 0,
      countTokens: async () => { throw new Error('OpenAI token count is unavailable.'); },
      sendRequest: async (messages, options, cancellation) => {
        const stream = this.inferenceStream(model.id, messages, options?.tools ?? [], cancellation);
        const text = async function* () { for await (const part of stream) { if (part instanceof vscode.LanguageModelTextPart) { yield part.value; } } };
        return { stream, text: text() } as vscode.LanguageModelChatResponse;
      } };
  }
  /** One lazy request per consumed stream; deltas arrive before response.completed. */
  private async *inferenceStream(modelId: string, messages: readonly vscode.LanguageModelChatMessage[],
    tools: readonly vscode.LanguageModelChatTool[], cancellation?: vscode.CancellationToken): AsyncGenerator<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> {
    const source = new vscode.CancellationTokenSource();
    const listener = cancellation?.onCancellationRequested(() => source.cancel());
    if (cancellation?.isCancellationRequested) { source.cancel(); }
    const queue: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    let wake: (() => void) | undefined, done = false, failure: unknown;
    const pending = this.infer(modelId, messages, tools, source.token, text => {
      queue.push(new vscode.LanguageModelTextPart(text)); wake?.();
    }).then(parts => { queue.push(...parts.filter(part => part instanceof vscode.LanguageModelToolCallPart)); }, error => { failure = error; })
      .finally(() => { done = true; wake?.(); });
    try {
      while (!done || queue.length) {
        if (queue.length) { yield queue.shift()!; }
        else { await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; }
      }
      if (failure) { throw failure; }
    } finally { source.cancel(); await pending; listener?.dispose(); source.dispose(); }
  }
  private toInput(messages: readonly vscode.LanguageModelChatMessage[]): unknown[] {
    const input: unknown[] = [];
    const replayed = new Set<unknown[]>();
    for (const message of messages) {
      const parts = message.content;
      const text = parts.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('\n');
      const images = parts.filter(part => part instanceof vscode.LanguageModelDataPart);
      if (images.length) {
        if (message.role !== vscode.LanguageModelChatMessageRole.User) throw new Error('Images require a user message.');
        const content = parts.flatMap(part => {
          if (part instanceof vscode.LanguageModelTextPart) return [{ type: 'input_text', text: part.value } as object];
          if (part instanceof vscode.LanguageModelDataPart) {
            if (!['image/png', 'image/jpeg'].includes(part.mimeType)) throw new Error('Unsupported image type. Choose PNG or JPEG.');
            return [{ type: 'input_image', image_url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`, detail: 'auto' }];
          }
          return [];
        });
        input.push({ role: 'user', content });
      } else if (text) { input.push({ role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user', content: text }); }
      for (const part of parts) {
        if (part instanceof vscode.LanguageModelToolCallPart) {
          const reasoning = this.reasoningByCall.get(part.callId);
          if (reasoning && !replayed.has(reasoning)) { input.push(...reasoning); replayed.add(reasoning); }
          input.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: JSON.stringify(part.input) });
        }
        else if (part instanceof vscode.LanguageModelToolResultPart) {
          const output = part.content.filter(item => item instanceof vscode.LanguageModelTextPart).map(item => item.value).join('\n');
          input.push({ type: 'function_call_output', call_id: part.callId, output });
        }
      }
    }
    return input;
  }
  private async infer(modelId: string, messages: readonly vscode.LanguageModelChatMessage[], tools: readonly vscode.LanguageModelChatTool[], cancellation?: vscode.CancellationToken,
    onText?: (text: string) => void): Promise<Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>> {
    const token = await this.auth.accessToken();
    const controller = new AbortController();
    const listener = cancellation?.onCancellationRequested(() => controller.abort());
    if (cancellation?.isCancellationRequested) { controller.abort(); }
    try {
      const response = await this.fetcher(`${api}/responses`, { method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId, input: this.toInput(messages), store: false, stream: true,
          ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema })) } : {}) }) });
      if (!response.ok) { let payload: unknown; try { payload = await response.json(); } catch { payload = {}; }
        const failure = responseError(payload); this.auth.noteApiFailure(response.status, failure.code); throw safeError(response.status, failure); }
      if (!response.body) { throw new Error('OpenAI response stream was unavailable.'); }
      const parsed = await readOpenAIResponseStream(response.body, onText);
      const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = parsed.text.map(text => new vscode.LanguageModelTextPart(text));
      const reasoning = parsed.output.filter(item => item.type === 'reasoning');
      for (const item of parsed.output) {
        if (item.type === 'function_call' && item.call_id && item.name && tools.some(tool => tool.name === item.name)) {
          let args: unknown; try { args = JSON.parse(item.arguments ?? '{}'); } catch { args = undefined; }
          if (args && typeof args === 'object' && !Array.isArray(args)) {
            this.reasoningByCall.set(item.call_id, reasoning);
            parts.push(new vscode.LanguageModelToolCallPart(item.call_id, item.name, args as object));
          }
        }
      }
      if (!parts.length) { throw new Error('OpenAI inference completed without text or function calls.'); }
      this.auth.noteApiSuccess();
      return parts;
    } catch (error) {
      if (controller.signal.aborted) { throw new vscode.CancellationError(); }
      if (error instanceof OpenAIStreamFailure) {
        if (error.kind === 'failed' || error.kind === 'error') { this.auth.noteApiFailure(400, error.code); throw safeError(400, { code: safeDiagnostic(error.code, /^[A-Za-z0-9_.-]{1,80}$/) }); }
        throw error;
      }
      if (error instanceof Error && (error.message.startsWith('OpenAI') || error.message.startsWith('ChatGPT') || error.message.startsWith('Selected'))) { throw error; }
      throw new Error('OpenAI inference is temporarily unavailable.');
    } finally { listener?.dispose(); }
  }
  async testConnection(modelId?: string): Promise<OpenAITestResult> {
    const start = Date.now();
    const result: OpenAITestResult = { connection: 'FAILED', modelDiscovery: 'FAILED', inference: 'FAILED', durationMs: 0 };
    try {
      await this.auth.accessToken(); result.connection = 'OK';
      const models = await this.listModels(); result.modelDiscovery = 'OK';
      const selected = modelId ? models.find(model => model.id === modelId) : models[0];
      if (!selected) { throw new Error('No selectable OpenAI models are available.'); }
      result.model = selected.id;
      const response = await this.infer(selected.id, [vscode.LanguageModelChatMessage.User('Reply with exactly: NX connection works.')], []);
      const text = response.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join('').trim();
      if (!text) { throw new Error('OpenAI inference completed without text.'); }
      result.inference = 'OK';
    } catch (error) { result.message = error instanceof Error ? error.message : 'OpenAI connection test failed.'; }
    result.durationMs = Date.now() - start;
    return result;
  }
}
