import type { OpenAIConfiguration } from '../runtime/openaiProvider';
import type { OpenAIConnectionState } from '../runtime/openaiAuth';
import type { MappingRole, MappingValidity } from '../runtime/autoConfiguration';
import type { SessionPage, SessionSummary } from './sessionStore';
import type { SidebarChatSnapshot } from './session';

export const sidebarViewId = 'nxRouter.sidebar';
export type ProviderAction = 'connect' | 'configureModels' | 'status' | 'retry';
export interface SidebarProvider {
  id: string;
  label: string;
  connection: OpenAIConnectionState;
  statusText: string;
  description: string;
  actions: ProviderAction[];
  autoAvailable: boolean;
  mappings: { role: MappingRole; modelId?: string; validity: MappingValidity }[];
}
export interface SidebarState {
  view: 'loading' | 'firstRun' | 'home' | 'needsAttention' | 'conversation' | 'sessions';
  providers: SidebarProvider[];
  linkedProviders?: { id: string; label: string; connection: string; selectable: boolean }[];
  activeProviderId?: string;
  telemetryEnabled: boolean;
  workspaceLabel: string;
  busy: boolean;
  notice?: string;
  chat?: SidebarChatSnapshot;
  historyAvailable?: boolean;
  recentSessions?: SessionSummary[];
  history?: SessionPage & { query: string };
}
const copy: Record<OpenAIConnectionState, [string, string, ProviderAction[]]> = {
  not_connected: ['Not connected', 'Connect an AI provider to start using NX Router.', ['connect']],
  connecting: ['Connecting to OpenAI…', 'Finish authentication in your browser.', []],
  connected: ['Connected', '', ['configureModels', 'status']],
  needs_reauthentication: ['Sign in required', 'Reconnect your ChatGPT account to continue.', ['connect', 'status']],
  permission_missing: ['Permission required', 'Reconnect and grant ChatGPT plan usage for NX Router.', ['connect', 'status']],
  usage_unavailable: ['Usage unavailable', 'ChatGPT plan usage is currently unavailable. Check your usage, then retry.', ['retry', 'status', 'connect']],
  error: ['Connection error', 'OpenAI connection needs attention. Retry or reconnect.', ['retry', 'connect', 'status']]
};
/** Explicit allowlist projection: never spread backend configuration or account identity. */
export function sidebarState(config: OpenAIConfiguration | undefined, telemetryEnabled: boolean, workspaceLabel: string,
  conversation = false, busy = false, notice?: string): SidebarState {
  if (!config) { return { view: 'loading', providers: [], telemetryEnabled, workspaceLabel, busy, notice }; }
  const [statusText, description, actions] = copy[config.state];
  const connected = config.state === 'connected';
  const provider: SidebarProvider = {
    id: config.providerId, label: 'OpenAI', connection: config.state, statusText,
    description: connected && !config.auto.available
      ? (() => { const role = config.auto.missingOrUnavailable[0]; return role ? `${role} model is ${config.mappings[role].validity === 'unconfigured' ? 'not configured' : 'not available'}.` : 'Configure models to enable Auto routing.'; })() : description,
    actions: [...actions], autoAvailable: config.auto.available,
    mappings: (['Router', 'LOW', 'MEDIUM', 'HIGH'] as const).map(role => ({
      role, modelId: config.mappings[role].modelId, validity: config.mappings[role].validity
    }))
  };
  return { view: config.state === 'not_connected' ? 'firstRun' : connected && conversation ? 'conversation'
    : !connected || !config.auto.available ? 'needsAttention' : 'home', providers: [provider], activeProviderId: connected ? provider.id : undefined,
    telemetryEnabled, workspaceLabel, busy, notice };
}

export type SidebarMessage = { type: 'ready' | 'newChat' | 'home' | 'settings' | 'telemetry' }
  | { type: 'sessions/viewAll' | 'navigation/sessions' }
  | { type: 'sessions/open' | 'sessions/delete'; sessionId: string }
  | { type: 'sessions/search'; query: string; offset: number }
  | { type: 'chat/new' | 'navigation/home' | 'navigation/conversation' }
  | { type: 'chat/send'; sessionId: string; text: string; requestId?: number }
  | { type: 'context/openPicker' | 'context/clear' | 'provider/openPicker'; sessionId: string }
  | { type: 'context/remove'; sessionId: string; id: string }
  | { type: 'chat/stop'; sessionId: string }
  | { type: 'execution/setAuto'; sessionId: string; on: boolean }
  | { type: 'execution/selectModel'; sessionId: string; providerId: string; modelId: string }
  | { type: 'execution/selectEffort'; sessionId: string; effort: string }
  | { type: 'link/open'; url: string }
  | { type: 'clipboard/copy'; text: string; requestId: number }
  | { type: 'provider'; providerId: string; action: ProviderAction };
export function parseSidebarMessage(input: unknown, providerIds: readonly string[]): SidebarMessage | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) { return; }
  const message = input as Record<string, unknown>;
  if (typeof message.type !== 'string') { return; }
  if (['ready', 'newChat', 'home', 'settings', 'telemetry', 'chat/new', 'navigation/home', 'navigation/conversation', 'sessions/viewAll', 'navigation/sessions'].includes(String(message.type)) && Object.keys(message).length === 1) {
    return message as SidebarMessage;
  }
  const exact = (keys: string[]) => Object.keys(message).length === keys.length && keys.every(key => Object.hasOwn(message, key));
  if (message.type === 'sessions/search' && exact(['type', 'query', 'offset']) && typeof message.query === 'string' && message.query.length <= 200
    && Number.isSafeInteger(message.offset) && Number(message.offset) >= 0 && Number(message.offset) <= 100000) return message as SidebarMessage;
  if (message.type === 'link/open' && exact(['type', 'url']) && safeExternalLink(message.url)) { return message as SidebarMessage; }
  if (message.type === 'clipboard/copy' && exact(['type', 'text', 'requestId']) && typeof message.text === 'string' && message.text.length <= 1000000
    && Number.isSafeInteger(message.requestId) && Number(message.requestId) > 0) { return message as SidebarMessage; }
  if (typeof message.sessionId === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(message.sessionId)) {
    if (['sessions/open', 'sessions/delete'].includes(message.type) && exact(['type', 'sessionId'])) return message as SidebarMessage;
    if (['context/openPicker', 'context/clear', 'provider/openPicker'].includes(message.type) && exact(['type', 'sessionId'])) return message as SidebarMessage;
    if (message.type === 'context/remove' && exact(['type', 'sessionId', 'id']) && typeof message.id === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(message.id)) return message as SidebarMessage;
    if (message.type === 'chat/stop' && exact(['type', 'sessionId'])) { return message as SidebarMessage; }
    if (message.type === 'chat/send' && (exact(['type', 'sessionId', 'text']) || (exact(['type', 'sessionId', 'text', 'requestId']) && Number.isSafeInteger(message.requestId) && Number(message.requestId) > 0)) && typeof message.text === 'string'
      && message.text.trim().length > 0 && message.text.length <= 16000) { return message as SidebarMessage; }
    if (message.type === 'execution/setAuto' && exact(['type', 'sessionId', 'on']) && typeof message.on === 'boolean') { return message as SidebarMessage; }
    if (message.type === 'execution/selectModel' && exact(['type', 'sessionId', 'providerId', 'modelId'])
      && typeof message.providerId === 'string' && providerIds.includes(message.providerId)
      && typeof message.modelId === 'string' && message.modelId.length > 0 && message.modelId.length <= 256) { return message as SidebarMessage; }
    if (message.type === 'execution/selectEffort' && exact(['type', 'sessionId', 'effort'])
      && typeof message.effort === 'string' && message.effort.length > 0 && message.effort.length <= 80) { return message as SidebarMessage; }
  }
  if (message.type === 'provider' && Object.keys(message).length === 3 && typeof message.providerId === 'string'
    && providerIds.includes(message.providerId) && typeof message.action === 'string' && ['connect', 'configureModels', 'status', 'retry'].includes(message.action)) {
    return message as SidebarMessage;
  }
}

export function safeExternalLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) { return; }
  try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password) { return url.href; } } catch { /* Invalid URL. */ }
}
