import { ProviderPicker } from '../sidebar/providerPicker';
import { ContextSources } from '../runtime/contextSources';
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ChatSessionStore } from '../sidebar/sessionStore';
import { SidebarAdapter } from '../sidebar/adapter';
import { SidebarController } from '../sidebar/controller';
import { parseSidebarMessage } from '../sidebar/state';
import { OpenAIAvailabilityMonitor } from '../runtime/openaiAvailabilityMonitor';
import { OpenAIAuth } from '../runtime/openaiAuth';
import { OpenAIConfiguration, OpenAIModel, OpenAIProvider } from '../runtime/openaiProvider';
import { NxProvider, NxProviderManager, NxProviderProfile } from '../runtime/providers';
import { NxRuntime, NxUserTurn } from '../runtime/nxRuntime';
import { ExecutionSessions } from '../runtime/executionSessions';
import { validateAutoMapping } from '../runtime/autoConfiguration';
import { Telemetry } from '../telemetry';
import { productionTools, evaluateCommand } from '../worker/toolPolicy';
import { ProductionTool } from '../worker/productionTools';
import { DiffContent } from '../workspace';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
export function chatFixture(runtime?: Pick<NxRuntime, 'run'>, store?: ChatSessionStore, confirmDelete?: () => Promise<boolean>, context?: ContextSources, manager?: NxProviderManager, picker?: ProviderPicker) {
  const profile: NxProviderProfile = { providerId: 'openai', auto: { router: { modelId: 'router-id' }, tiers: {
    LOW: { modelId: 'low-id' }, MEDIUM: { modelId: 'worker-id' }, HIGH: { modelId: 'high-id' }
  } } };
  let models: OpenAIModel[] = ['router-id', 'low-id', 'worker-id', 'high-id'].map(id => ({ id, name: id, availability: 'available', effortOptions: [] }));
  let valid = true, connected = true;
  const config = (): OpenAIConfiguration => {
    const configured = { ...profile, auto: { ...profile.auto, router: { modelId: valid ? 'router-id' : '' } } };
    const auto = validateAutoMapping(configured, models.map(model => model.id), connected);
    return { state: connected ? 'connected' : 'needs_reauthentication', providerId: 'openai', profileId: 'PRIVATE_IDENTITY',
      modelMappingComplete: auto.available, auto, models, mappings: Object.fromEntries(Object.entries(auto.mappings).map(([role, model]) =>
        [role, { modelId: model.modelId, validity: model.validity, available: model.valid, effort: 'provider default' }])) as OpenAIConfiguration['mappings'] };
  };
  const executions = new ExecutionSessions();
  const monitor = new OpenAIAvailabilityMonitor({ configuration: async () => config(), refreshConfiguration: async () => config() } as OpenAIProvider, executions, () => {});
  let publishes = 0;
  const adapter = new SidebarAdapter(monitor, executions, runtime ?? { run: async () => ({}) }, () => profile, () => { publishes++; controller.publish(); }, store, context, manager, picker);
  const controller = new SidebarController(monitor, [{ id: 'openai', commands: { connect: 'connect', configureModels: 'models', status: 'status' } }],
    () => ({ telemetryEnabled: true, workspaceLabel: 'workspace' }), async () => {}, adapter, confirmDelete);
  const message = (type: string, extra = {}) => controller.receive({ type, sessionId: adapter.snapshot()!.sessionId, ...extra });
  return { profile, monitor, executions, adapter, controller, message, config, get models() { return models; }, set models(value) { models = value; },
    set valid(value: boolean) { valid = value; }, set connected(value: boolean) { connected = value; }, get publishes() { return publishes; },
    async start() { await controller.refresh(); await controller.receive({ type: 'chat/new' }); },
    dispose() { controller.dispose(); monitor.dispose(); } };
}

export async function sidebarChatTests(test: (name: string, fn: () => Promise<void>) => Promise<void>): Promise<void> {
  await test('UI-03 real thread/composer assets replace placeholder with safe persistent DOM updates', async () => {
    const js = await fs.readFile(path.resolve(__dirname, '../../media/sidebar.js'), 'utf8');
    assert.doesNotMatch(js, /Chat UI arrives|innerHTML|insertAdjacentHTML|eval\(|setState\(/);
    for (const fragment of ["element('textarea'", "'chat/send'", "'chat/stop'", "'execution/setAuto'", 'textContent', 'stickToBottom', 'isComposing']) assert.ok(js.includes(fragment));
  });
  await test('UI-03 fresh in-memory session, Auto defaults, forced OFF and explicit repair semantics', async () => {
    const f = chatFixture();
    try {
      await f.start(); const first = f.adapter.snapshot()!.sessionId;
      assert.equal(f.adapter.snapshot()!.autoOn, true);
      assert.equal(await f.message('execution/setAuto', { on: false }), true); assert.equal(f.adapter.snapshot()!.autoOn, false);
      assert.equal(await f.message('execution/setAuto', { on: true }), true);
      f.valid = false; await f.monitor.refresh();
      assert.equal(f.adapter.snapshot()!.autoOn, false); assert.equal(f.adapter.snapshot()!.autoAvailable, false);
      assert.equal(await f.message('execution/setAuto', { on: true }), false);
      await f.controller.receive({ type: 'chat/new' }); assert.equal(f.adapter.snapshot()!.autoOn, false);
      f.valid = true; await f.monitor.refresh(); assert.equal(f.adapter.snapshot()!.autoAvailable, true); assert.equal(f.adapter.snapshot()!.autoOn, false);
      assert.equal(await f.message('execution/setAuto', { on: true }), true);
      await f.controller.receive({ type: 'chat/new' });
      assert.notEqual(f.adapter.snapshot()!.sessionId, first); assert.equal(f.adapter.snapshot()!.autoOn, true);
      assert.equal(f.executions.has(first), false); assert.deepEqual(f.adapter.snapshot()!.messages, []);
    } finally { f.dispose(); }
  });
  await test('UI-03 current catalog Manual choice, session memory, capabilities and stale selection denial', async () => {
    const turns: NxUserTurn[] = [];
    const f = chatFixture({ run: async turn => { turns.push(turn); return {}; } });
    try {
      await f.start(); await f.message('execution/setAuto', { on: false });
      assert.deepEqual(f.adapter.snapshot()!.models.map(model => model.id), f.models.map(model => model.id));
      assert.equal(f.adapter.snapshot()!.canSend, false);
      assert.equal(await f.message('execution/selectModel', { providerId: 'openai', modelId: 'foreign-id' }), false);
      assert.equal(await f.message('execution/selectModel', { providerId: 'other', modelId: 'worker-id' }), false);
      assert.equal(await f.message('execution/selectModel', { providerId: 'openai', modelId: 'worker-id' }), true);
      assert.deepEqual(f.adapter.snapshot()!.effortOptions, []);
      assert.equal(await f.message('execution/selectEffort', { effort: 'high' }), false);
      assert.equal(await f.message('execution/selectEffort', { effort: 'default' }), true);
      await f.message('chat/send', { text: 'First' });
      await f.message('execution/setAuto', { on: true }); await f.message('execution/setAuto', { on: false });
      assert.equal(f.adapter.snapshot()!.manualModelId, 'worker-id');
      f.models = f.models.map(model => model.id === 'worker-id' ? { ...model, effortOptions: ['measured-effort'] } : model);
      await f.monitor.refresh();
      assert.equal(await f.message('execution/selectEffort', { effort: 'measured-effort' }), true);
      await f.message('chat/send', { text: 'Second' });
      assert.deepEqual(turns[1].execution, { mode: 'manual', providerId: 'openai', model: { modelId: 'worker-id', effort: 'measured-effort' } });
      f.models = f.models.filter(model => model.id !== 'worker-id'); await f.monitor.refresh();
      assert.equal(f.adapter.snapshot()!.manualModelId, 'worker-id'); assert.equal(f.adapter.snapshot()!.manualValid, false);
      assert.equal(await f.message('chat/send', { text: 'Cannot execute' }), false);
      assert.equal(await f.message('execution/selectModel', { providerId: 'openai', modelId: 'worker-id' }), false);
      await f.controller.receive({ type: 'chat/new' }); assert.equal(f.adapter.snapshot()!.manualModelId, undefined);
    } finally { f.dispose(); }
  });
  await test('UI-03 streaming one assistant, completion, rolling continuity and safe error projection', async () => {
    const firstDelta = deferred(), resume = deferred();
    const turns: NxUserTurn[] = [];
    const f = chatFixture({ run: async (turn, emit) => {
      turns.push(turn); emit({ type: 'route', route: 'MEDIUM' }); emit({ type: 'model', providerId: 'openai', modelId: 'worker-id' });
      emit({ type: 'toolStart', tool: 'nx_read' }); emit({ type: 'toolResult', tool: 'nx_read', outcome: 'success' });
      emit({ type: 'textDelta', text: 'Hello <script>bad()</script>' }); firstDelta.resolve(); await resume.promise;
      emit({ type: 'textDelta', text: ' world' }); emit({ type: 'escalation', from: 'MEDIUM', to: 'HIGH', completed: true });
      emit({ type: 'completion', status: 'completed', finalRoute: 'HIGH' });
      return { metadata: { nxSessionState: { version: 1, sessionId: turn.sessionId!, activeTargets: [], recentActions: [], currentObjective: 'summary', updatedAt: new Date().toISOString() } } };
    } });
    try {
      await f.start(); const flight = f.message('chat/send', { text: 'First' }); await firstDelta.promise;
      assert.equal(f.adapter.snapshot()!.running, true); assert.equal(f.adapter.snapshot()!.messages.length, 2);
      assert.equal(f.adapter.snapshot()!.messages[1].text, 'Hello <script>bad()</script>');
      assert.equal(await f.message('chat/send', { text: 'Duplicate' }), false);
      assert.equal(await f.message('execution/setAuto', { on: false }), false);
      resume.resolve(); await flight;
      assert.equal(f.adapter.snapshot()!.messages.length, 2); assert.equal(f.adapter.snapshot()!.messages[1].text, 'Hello <script>bad()</script> world');
      assert.equal(f.adapter.snapshot()!.messages[1].status, 'completed'); assert.equal(f.adapter.snapshot()!.running, false);
      assert.match(f.adapter.snapshot()!.executionLabel!, /MEDIUM → HIGH/);
      await f.message('chat/send', { text: 'continue' }); assert.equal(turns[1].previous?.currentObjective, 'summary');
      assert.equal(turns[1].conversation?.length, 2);
      await f.controller.receive({ type: 'navigation/home' }); assert.notEqual(f.controller.state().view, 'conversation');
      await f.controller.receive({ type: 'navigation/conversation' }); assert.equal(f.controller.state().chat!.messages.length, 4);
      f.connected = false; await f.monitor.refresh();
      assert.equal(f.controller.state().view, 'conversation'); assert.equal(f.adapter.snapshot()!.messages.length, 4);
      assert.equal(f.adapter.snapshot()!.canSend, false); assert.equal(f.adapter.snapshot()!.autoOn, false);
      f.connected = true; await f.monitor.refresh(); assert.equal(f.adapter.snapshot()!.autoOn, false);
      assert.doesNotMatch(JSON.stringify(f.controller.state()), /PRIVATE_IDENTITY|nxSessionState|nxTurn|nx_read/);
      await f.controller.receive({ type: 'chat/new' }); await f.message('chat/send', { text: 'fresh' });
      assert.equal(turns[2].previous, undefined); assert.deepEqual(turns[2].conversation, []);
      assert.notEqual(turns[2].segmentId, turns[0].segmentId);
    } finally { resume.resolve(); f.dispose(); }
  });
  await test('UI-03 Stop and New Chat cancel backend, preserve partial text and reject stale actions', async () => {
    let started = deferred(); let cancelled = false;
    const f = chatFixture({ run: async (turn, emit) => {
      emit({ type: 'textDelta', text: 'partial' }); started.resolve();
      await new Promise<void>(resolve => { const listener = turn.token.onCancellationRequested(() => { cancelled = true; listener.dispose(); resolve(); }); });
      emit({ type: 'cancellation' }); return {};
    } });
    try {
      await f.start(); const id = f.adapter.snapshot()!.sessionId;
      const flight = f.message('chat/send', { text: 'long request' }); await started.promise;
      assert.equal(await f.message('chat/stop'), true); await flight;
      assert.equal(cancelled, true); assert.equal(f.adapter.snapshot()!.messages[1].text, 'partial');
      assert.equal(f.adapter.snapshot()!.messages[1].status, 'cancelled'); assert.equal(f.adapter.snapshot()!.running, false);
      started = deferred(); const next = f.message('chat/send', { text: 'another' }); await started.promise;
      await f.controller.receive({ type: 'chat/new' }); await next;
      assert.notEqual(f.adapter.snapshot()!.sessionId, id); assert.deepEqual(f.adapter.snapshot()!.messages, []);
      assert.equal(await f.controller.receive({ type: 'chat/stop', sessionId: id }), false);
      assert.equal(await f.controller.receive({ type: 'execution/setAuto', sessionId: id, on: false }), false);
    } finally { f.dispose(); }
  });
  await test('UI-03 runtime error and thrown exception finalize safely without raw payload or stuck busy', async () => {
    for (const throws of [false, true]) {
      const f = chatFixture({ run: async (_turn, emit) => {
        emit({ type: 'textDelta', text: 'partial' });
        if (throws) throw new Error('ACCESS_SECRET raw response stack');
        emit({ type: 'error', message: 'ACCESS_SECRET raw response stack' });
        emit({ type: 'textDelta', source: 'error', text: 'ACCESS_SECRET' });
        emit({ type: 'textDelta', source: 'status', text: 'PRIVATE tool payload' }); return {};
      } });
      try {
        await f.start(); await f.message('chat/send', { text: 'request' });
        assert.equal(f.adapter.snapshot()!.messages[1].status, 'failed'); assert.equal(f.adapter.snapshot()!.running, false);
        assert.doesNotMatch(JSON.stringify(f.controller.state()), /ACCESS_SECRET|PRIVATE|stack/);
      } finally { f.dispose(); }
    }
  });
  await test('UI-03 preflight invalidation never silently changes an Auto request into Manual', async () => {
    let calls = 0;
    const f = chatFixture({ run: async () => { calls++; return {}; } });
    try {
      await f.start(); await f.message('execution/setAuto', { on: false });
      await f.message('execution/selectModel', { providerId: 'openai', modelId: 'worker-id' });
      await f.message('execution/setAuto', { on: true });
      f.valid = false; // Host snapshot was valid; asynchronous Send preflight discovers the change.
      await f.message('chat/send', { text: 'Auto request' });
      assert.equal(calls, 0); assert.equal(f.adapter.snapshot()!.autoOn, false);
      assert.deepEqual(f.adapter.snapshot()!.messages, []); assert.equal(f.adapter.snapshot()!.running, false);
      assert.match(f.adapter.snapshot()!.contextNotice!, /Send could not start/);
      await f.message('chat/send', { text: 'Explicit subsequent Manual request' }); assert.equal(calls, 1);
    } finally { f.dispose(); }
  });
  await test('UI-03 account interruption cancels active runtime and preserves visible partial conversation', async () => {
    const started = deferred(); let cancelled = false;
    const f = chatFixture({ run: async (turn, emit) => {
      emit({ type: 'textDelta', text: 'retained partial' }); started.resolve();
      await new Promise<void>(resolve => { const listener = turn.token.onCancellationRequested(() => { cancelled = true; listener.dispose(); resolve(); }); });
      emit({ type: 'cancellation' }); return {};
    } });
    try {
      await f.start(); const flight = f.message('chat/send', { text: 'read-only request' }); await started.promise;
      f.connected = false; await f.monitor.refresh(); await flight;
      assert.equal(cancelled, true); assert.equal(f.controller.state().view, 'conversation');
      assert.equal(f.adapter.snapshot()!.messages[1].text, 'retained partial'); assert.equal(f.adapter.snapshot()!.canSend, false);
      f.connected = true; await f.monitor.refresh(); assert.equal(f.adapter.snapshot()!.autoOn, false);
      assert.equal(f.adapter.snapshot()!.messages[1].status, 'cancelled');
    } finally { f.dispose(); }
  });
  await test('UI-03 strict chat bridge schema rejects unexpected fields, malformed values and unknown actions', async () => {
    const base = { sessionId: 'session-valid-123' };
    for (const message of [
      { type: 'chat/send', ...base, text: '' }, { type: 'chat/send', ...base, text: ' ' },
      { type: 'chat/send', ...base, text: 'x'.repeat(16001) }, { type: 'chat/send', ...base, text: 'hi', token: 'SECRET' },
      { type: 'chat/stop', ...base, extra: true }, { type: 'execution/setAuto', ...base, on: 'true' },
      { type: 'execution/selectEffort', ...base, effort: [] }, { type: 'chat/send', text: 'hi' },
      { type: 'execution/anything', ...base }, { type: 'chat/new', extra: true }
    ]) assert.equal(parseSidebarMessage(message, ['openai']), undefined);
    assert.ok(parseSidebarMessage({ type: 'chat/send', ...base, text: 'hello' }, ['openai']));
  });
  await test('UI-03 Sidebar through real NxRuntime: Auto Router mapping, Manual no Router, risk and production read path', async () => {
    const records: any[] = [], requests: { id: string; messages: readonly vscode.LanguageModelChatMessage[] }[] = [];
    let f: ReturnType<typeof chatFixture>;
    let workerRound = 0;
    const provider: NxProvider = { id: 'openai', label: 'Fake OpenAI', connectionStatus: async () => 'connected',
      profile: () => f.profile, autoAvailability: async () => f.config().auto, listModels: async () => f.models,
      resolveModel: async selection => {
        if (!f.models.some(model => model.id === selection.modelId)) return undefined;
        return { id: selection.modelId, vendor: 'openai', countTokens: async () => 1, sendRequest: async (messages: readonly vscode.LanguageModelChatMessage[]) => {
          requests.push({ id: selection.modelId, messages });
          if (selection.modelId === 'router-id') return { text: (async function* () { yield JSON.stringify({ route: 'MEDIUM', confidence: 0.95,
            reason: 'Read summary', normalized_task: 'Read the file', intent: 'investigate', scope: 'single_file', needs_more_context: false, missing_context: [], risk_flags: [] }); })() };
          return { stream: (async function* () {
            if (workerRound++ === 0) yield new vscode.LanguageModelToolCallPart('sidebar-read', productionTools.read, { path: 'sidebar-read.txt' });
            else { yield new vscode.LanguageModelTextPart('Shared '); yield new vscode.LanguageModelTextPart('response'); }
          })() };
        } } as unknown as vscode.LanguageModelChat;
      } };
    const telemetry = { startSession: async (id: string) => { records.push({ session_id: id }); }, recordModel: async (r: object) => { records.push(r); },
      recordTurn: async (r: object) => { records.push(r); }, recordTool: async (r: object) => { records.push(r); } } as unknown as Telemetry;
    f = chatFixture(new NxRuntime(telemetry, new NxProviderManager([provider])));
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'sidebar-read.txt');
    await vscode.workspace.fs.writeFile(file, Buffer.from('read-only fixture'));
    try {
      await f.start(); await f.message('chat/send', { text: 'Read sidebar-read.txt and summarize without changing files.' });
      assert.equal(requests[0].id, 'router-id'); assert.ok(requests.some(r => r.id === 'worker-id'));
      assert.ok(records.some(r => r.tool === 'nx_read' && r.outcome === 'success'));
      assert.equal(f.adapter.snapshot()!.messages[1].text, 'Shared response'); assert.equal(f.adapter.snapshot()!.messages[1].status, 'completed');
      assert.ok(records.some(r => r.role === 'router'));
      assert.equal(f.adapter.snapshot()!.messages[1].turn!.tools[0].target, 'sidebar-read.txt');
      assert.equal(f.adapter.snapshot()!.messages[1].turn!.tools[0].state, 'success');
      requests.length = 0; records.length = 0;
      await f.message('execution/setAuto', { on: false }); await f.message('execution/selectModel', { providerId: 'openai', modelId: 'low-id' });
      await f.message('chat/send', { text: 'change authentication permissions' });
      assert.ok(requests.length); assert.ok(requests.every(r => r.id === 'low-id'));
      assert.match(JSON.stringify(requests[0].messages), /Shared response/); assert.equal(records.some(r => r.role === 'router'), false);
      assert.ok(records.some(r => r.routing_mode === 'manual' && r.risk_floor === 'HIGH' && r.router_request_count === 0));
      assert.equal(evaluateCommand('rm', ['-rf', '/']).allowed, false);
      assert.match(f.adapter.snapshot()!.executionLabel!, /Manual · low-id/);
      assert.doesNotMatch(f.adapter.snapshot()!.executionLabel!, /Default/);
      const approval = new ProductionTool(productionTools.edit, new DiffContent()).prepareInvocation({ input: { path: 'disposable.txt' } } as vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>);
      assert.ok(approval.confirmationMessages); assert.match(String(approval.confirmationMessages!.message), /exact diff/);
      assert.doesNotMatch(JSON.stringify(records), /read-only fixture|change authentication permissions|Shared response/);
      await f.message('execution/setAuto', { on: true }); requests.length = 0;
      await f.message('chat/send', { text: 'Read again without changes' }); assert.equal(requests[0].id, 'router-id');
    } finally { f.dispose(); await vscode.workspace.fs.delete(file); }
  });
  await test('UI-03 production OpenAI bridge emits before completion and aborts HTTP on Stop', async () => {
    const profile = { id: 'fake-profile' };
    const auth = { selectedProfile: () => profile, status: async () => ({ state: 'connected', profileId: profile.id }),
      accessToken: async () => 'TOKEN_NEVER_PROJECTED', noteApiSuccess: () => {}, noteApiFailure: () => {} } as unknown as OpenAIAuth;
    let responseController!: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal | undefined;
    const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    const fetcher = (async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ models: [{ slug: 'actual-model', display_name: 'Actual model', visibility: 'list' }] });
      signal = options?.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        responseController = controller;
        signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        controller.enqueue(frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'live partial' }));
      } }));
    }) as typeof fetch;
    const provider = new OpenAIProvider(auth, { get: () => undefined } as unknown as vscode.Memento, fetcher);
    const source = new vscode.CancellationTokenSource();
    try {
      await provider.listModels(); const model = (await provider.resolveModel({ modelId: 'actual-model' }))!;
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('read')], {}, source.token);
      const iterator = response.stream[Symbol.asyncIterator]();
      const next = await Promise.race([iterator.next(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Buffered until completion')), 2000))]);
      assert.ok(next.value instanceof vscode.LanguageModelTextPart); assert.equal((next.value as vscode.LanguageModelTextPart).value, 'live partial');
      responseController.enqueue(frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'live partial' }));
      responseController.enqueue(frame({ type: 'response.completed', response: {} }));
      assert.equal((await iterator.next()).done, true); // no repeated finalized text
      const second = await model.sendRequest([vscode.LanguageModelChatMessage.User('read')], {}, source.token);
      const interrupted = second.stream[Symbol.asyncIterator](); await interrupted.next();
      source.cancel(); await assert.rejects(interrupted.next(), error => error instanceof vscode.CancellationError);
      assert.equal(signal?.aborted, true);
    } finally { source.dispose(); provider.dispose(); }
  });
  await test('UI-03 Stop propagates through real NxRuntime into worker provider cancellation', async () => {
    const started = deferred(); let aborted = false; let f: ReturnType<typeof chatFixture>;
    const provider: NxProvider = { id: 'openai', label: 'Fake OpenAI', connectionStatus: async () => 'connected', listModels: async () => f.models,
      resolveModel: async selection => ({ id: selection.modelId, vendor: 'openai', countTokens: async () => 1,
        sendRequest: async (_messages: unknown, _options: unknown, token: vscode.CancellationToken) => ({ stream: (async function* () {
          yield new vscode.LanguageModelTextPart('partial provider output'); started.resolve();
          await new Promise<void>(resolve => { const listener = token.onCancellationRequested(() => { aborted = true; listener.dispose(); resolve(); }); });
          throw new vscode.CancellationError();
        })() }) } as unknown as vscode.LanguageModelChat) };
    const records: any[] = [];
    const telemetry = { startSession: async () => {}, recordModel: async () => {}, recordTool: async () => {}, recordTurn: async (r: object) => { records.push(r); } } as unknown as Telemetry;
    f = chatFixture(new NxRuntime(telemetry, new NxProviderManager([provider])));
    try {
      await f.start(); await f.message('execution/setAuto', { on: false }); await f.message('execution/selectModel', { providerId: 'openai', modelId: 'worker-id' });
      const flight = f.message('chat/send', { text: 'long read-only answer' }); await started.promise;
      await f.message('chat/stop'); await flight;
      assert.equal(aborted, true); assert.equal(f.adapter.snapshot()!.messages[1].text, 'partial provider output');
      assert.equal(f.adapter.snapshot()!.messages[1].status, 'cancelled'); assert.equal(records[0].status, 'cancelled');
    } finally { f.dispose(); }
  });
}
