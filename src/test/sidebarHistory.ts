import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ChatSessionStore, SavedSession, parseSavedSession, sessionTitle, workspaceSessionKey } from '../sidebar/sessionStore';
import { parseSidebarMessage } from '../sidebar/state';
import { chatFixture } from './sidebarChat';
import { NxRuntime, NxUserTurn } from '../runtime/nxRuntime';
import { NxProvider, NxProviderManager } from '../runtime/providers';
import { Telemetry } from '../telemetry';

const date = '2026-10-09T01:00:00.000Z';
function record(id = 'session-history-123', prompt = '  Explain\n NX Router  '): SavedSession {
  return { schemaVersion: 3, sessionId: id, providerId: 'openai', segmentId: 'segment-history-123', title: sessionTitle(prompt), createdAt: date, updatedAt: date,
    segments: [{ id: 'segment-history-123', sessionId: id, providerId: 'openai', providerLabel: 'OpenAI', startIndex: 0, contextCarryMode: 'fresh', createdAt: date }],
    execution: { autoOn: true }, rolling: { version: 1, sessionId: id, currentObjective: 'Compact objective', activeTargets: ['README.md'], recentActions: ['Read'], updatedAt: date },
    messages: [{ id: 'user-history-123', role: 'user', text: prompt, createdAt: date }, { id: 'assistant-history-123', role: 'assistant', text: '## Answer\nคำตอบ', createdAt: date, status: 'completed',
      turn: { messageId: 'assistant-history-123', mode: 'auto', status: 'completed', route: 'MEDIUM', modelId: 'worker-id', modelName: 'Captured Sol', effort: 'measured-effort',
        escalation: { from: 'LOW', to: 'MEDIUM', completed: true }, tools: [{ id: 'tool-history-123', label: 'Edit', target: 'src/a.ts', state: 'success', durationMs: 25 }], changedFiles: ['src/a.ts'] } }] };
}
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui05-'));
export async function sidebarHistoryTests(test: (name: string, fn: () => Promise<void>) => Promise<void>): Promise<void> {
  await test('UI-05 deterministic first-prompt titles preserve Thai graphemes and Unicode', async () => {
    assert.equal(sessionTitle('  Fix\n\t Sidebar  tool status '), 'Fix Sidebar tool status');
    assert.equal(sessionTitle(' \n\t '), 'New chat');
    const unit = 'ก้'; const title = sessionTitle(unit.repeat(100));
    assert.equal(title, unit.repeat(71) + '…');
    assert.equal(sessionTitle('👨‍👩‍👧‍👦'.repeat(100)), '👨‍👩‍👧‍👦'.repeat(71) + '…');
    assert.equal(sessionTitle('ภาษาไทย อธิบายโปรเจกต์นี้'), 'ภาษาไทย อธิบายโปรเจกต์นี้');
  });
  await test('UI-05 store roundtrip keeps transcript, captured execution, safe activity and separate rolling state', async () => {
    const directory = await temp(); const store = new ChatSessionStore(directory);
    try {
      await store.initialize(); const session = record();
      (session as any).accessToken = 'SECRET'; (session as any).responseMetadata = { raw: 'RAW_PAYLOAD', encrypted_reasoning: 'HIDDEN' };
      Object.assign(session.messages[1].turn!.tools[0], { arguments: { secret: 'RAW_ARGUMENTS' }, result: 'RAW_RESULT', stdout: 'OUTPUT_DUMP' });
      await store.save(session); const loaded = (await store.load(session.sessionId))!;
      assert.deepEqual(loaded.messages, parseSavedSession(session)!.messages); assert.deepEqual(loaded.rolling, parseSavedSession(session)!.rolling);
      assert.equal(loaded.messages[1].turn!.modelName, 'Captured Sol');
      const json = await fs.readFile(path.join(directory, `${session.sessionId}.json`), 'utf8');
      assert.doesNotMatch(json, /SECRET|RAW_PAYLOAD|HIDDEN|RAW_ARGUMENTS|RAW_RESULT|OUTPUT_DUMP|responseMetadata/);
      const stat = await fs.stat(path.join(directory, `${session.sessionId}.json`)); assert.equal(stat.mode & 0o077, 0);
      assert.equal((await fs.readdir(directory)).some(file => file.endsWith('.tmp')), false);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 empty New Chat has no history spam; meaningful turn saves stable first title and clean identities', async () => {
    const directory = await temp(); let calls = 0;
    const store = new ChatSessionStore(directory), f = chatFixture({ run: async (_turn, emit) => { calls++; emit({ type: 'textDelta', text: 'Response' }); return {}; } }, store);
    try {
      await f.start(); await f.controller.receive({ type: 'chat/new' }); await f.controller.receive({ type: 'chat/new' });
      assert.deepEqual(store.list(), []);
      const id = f.adapter.snapshot()!.sessionId;
      await f.message('chat/send', { text: '   First\n meaningful prompt  ' });
      assert.equal(store.list().length, 1); assert.equal(store.list()[0].title, 'First meaningful prompt');
      await f.message('chat/send', { text: 'Different second prompt' }); assert.equal(store.list()[0].title, 'First meaningful prompt');
      assert.equal(calls, 2);
      await f.controller.receive({ type: 'chat/new' }); assert.notEqual(f.adapter.snapshot()!.sessionId, id);
      assert.deepEqual(f.adapter.snapshot()!.messages, []); assert.equal(f.adapter.snapshot()!.manualModelId, undefined);
      assert.equal(store.list().length, 1); assert.equal(store.lastActive, undefined);
      assert.equal((await store.load(id))!.messages.length, 4);
    } finally { f.dispose(); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 restart restores last chat without runtime requests and reopens immutable snapshots', async () => {
    const directory = await temp(); const store = new ChatSessionStore(directory); let calls = 0;
    const session = record(); await store.save(session);
    const restarted = new ChatSessionStore(directory), f = chatFixture({ run: async turn => {
      calls++; assert.equal(turn.previous?.currentObjective, 'Compact objective'); assert.equal(turn.segmentId, session.segmentId); return {};
    } }, restarted);
    try {
      f.models = f.models.map(model => ({ ...model, name: 'New catalog name' }));
      await f.adapter.initialize(); assert.equal(calls, 0);
      assert.equal(f.adapter.snapshot()!.sessionId, session.sessionId);
      assert.equal(f.controller.state().chat!.messages.length, 0, 'Home projects no transcript');
      assert.equal(f.controller.state().recentSessions![0].sessionId, session.sessionId);
      await f.controller.receive({ type: 'sessions/open', sessionId: session.sessionId }); assert.equal(calls, 0);
      assert.equal(f.controller.state().chat!.messages[1].turn!.modelName, 'Captured Sol');
      assert.equal(f.controller.state().chat!.messages[1].turn!.effort, 'measured-effort');
      await f.message('chat/send', { text: 'continue' }); assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(f.controller.state()), /Compact objective|chat-sessions|schemaVersion|responseMetadata|PRIVATE_IDENTITY/);
    } finally { f.dispose(); await restarted.flush(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 reopened later turn uses real shared NxRuntime, bounded continuity and metadata-only telemetry', async () => {
    const directory = await temp(); const store = new ChatSessionStore(directory); const session = record();
    session.execution = { autoOn: false, manual: { modelId: 'worker-id' } }; await store.save(session);
    let requests = 0; const records: object[] = []; let f: ReturnType<typeof chatFixture>;
    const provider: NxProvider = { id: 'openai', label: 'Fake', connectionStatus: async () => 'connected', listModels: async () => f.models,
      resolveModel: async selection => ({ id: selection.modelId, vendor: 'openai', countTokens: async () => 1,
        sendRequest: async (messages: readonly vscode.LanguageModelChatMessage[]) => {
          requests++; assert.match(JSON.stringify(messages), /Compact objective/);
          return { stream: (async function* () { yield new vscode.LanguageModelTextPart('New runtime response'); })() };
        } } as unknown as vscode.LanguageModelChat) };
    const telemetry = { startSession: async (id: string) => { records.push({ session_id: id }); }, recordModel: async (row: object) => { records.push(row); },
      recordTurn: async (row: object) => { records.push(row); }, recordTool: async (row: object) => { records.push(row); } } as unknown as Telemetry;
    f = chatFixture(new NxRuntime(telemetry, new NxProviderManager([provider])), store);
    try {
      await f.controller.receive({ type: 'sessions/open', sessionId: session.sessionId });
      await f.controller.receive({ type: 'sessions/viewAll' }); await f.controller.receive({ type: 'sessions/search', query: 'Explain', offset: 0 });
      assert.equal(requests, 0); assert.deepEqual(records, []);
      await f.controller.receive({ type: 'navigation/conversation' }); await f.message('chat/send', { text: 'continue' });
      assert.equal(requests, 1); assert.equal(f.adapter.snapshot()!.messages.at(-1)!.text, 'New runtime response');
      assert.doesNotMatch(JSON.stringify(records), /Explain|Compact objective|New runtime response|คำตอบ|Captured Sol/);
      assert.ok((records as any[]).some(row => row.session_id === session.sessionId && row.routing_mode === 'manual' && row.router_request_count === 0));
    } finally { f.dispose(); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 recents sorted, summary-only View All, deterministic local title/user search and paging', async () => {
    const directory = await temp(); const store = new ChatSessionStore(directory);
    try {
      for (let i = 0; i < 52; i++) { const session = record(`history-session-${String(i).padStart(3, '0')}`, `ภาษาไทย prompt ${i}`);
        session.updatedAt = new Date(Date.parse(date) + i * 1000).toISOString(); await store.save(session); }
      assert.equal(store.list()[0].title, 'ภาษาไทย prompt 51'); assert.equal(store.list().length, 6);
      const all = await store.search(''); assert.equal(all.items.length, 50); assert.equal(all.hasMore, true);
      assert.equal((await store.search('', 50)).items.length, 2);
      assert.doesNotMatch(JSON.stringify(all), /messages|rolling|tools|คำตอบ/);
      assert.equal((await store.search('PROMPT 51')).items.length, 1);
      assert.equal((await store.search('ภาษาไทย')).items.length, 50);
      const other = record('history-user-only', 'A title'); other.messages.push({ id: 'extra-user-message', role: 'user', text: 'Unique USER text', createdAt: date });
      await store.save(other); assert.equal((await store.search('unique user')).items[0].sessionId, other.sessionId);
      assert.deepEqual((await store.search('no matches')).items, []);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 workspace URI hashes isolate identical visible folder names and workspace switching', async () => {
    const directory = await temp();
    const aKey = workspaceSessionKey('file:///one/project'), bKey = workspaceSessionKey('file:///two/project');
    assert.notEqual(aKey, bKey); assert.match(aKey, /^[a-f0-9]{64}$/);
    const a = new ChatSessionStore(path.join(directory, aKey)), b = new ChatSessionStore(path.join(directory, bKey));
    await a.save(record()); const f = chatFixture(undefined, a);
    try {
      await f.adapter.initialize(); assert.equal(f.adapter.snapshot()!.messages.length, 2);
      await f.controller.changeWorkspace(b); assert.equal(f.adapter.snapshot(), undefined); assert.deepEqual(b.list(), []);
      await f.controller.changeWorkspace(a); assert.equal(f.adapter.snapshot()!.messages.length, 2);
    } finally { f.dispose(); await a.flush(); await b.flush(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 corrupt individual/last chat fails safely; corrupt index rebuilds without deleting files', async () => {
    const directory = await temp(), logs: string[] = []; const store = new ChatSessionStore(directory, category => logs.push(category));
    try {
      await store.save(record('history-valid-one')); await store.save(record('history-bad-two'));
      await fs.writeFile(path.join(directory, 'history-bad-two.json'), '{PRIVATE_BROKEN_JSON');
      await fs.writeFile(path.join(directory, 'index.json'), '{BROKEN_INDEX');
      const recovered = new ChatSessionStore(directory, category => logs.push(category)); await recovered.initialize();
      assert.deepEqual(recovered.list().map(row => row.sessionId), ['history-valid-one']);
      assert.equal(recovered.lastActive, 'history-valid-one'); assert.ok(logs.length); assert.doesNotMatch(logs.join('\n'), /PRIVATE|BROKEN|\/tmp/);
      assert.ok((await fs.readdir(directory)).includes('history-bad-two.json'));
      await fs.writeFile(path.join(directory, 'history-valid-one.json'), '{}');
      const f = chatFixture(undefined, recovered); await f.adapter.initialize(); assert.equal(f.adapter.snapshot(), undefined); f.dispose();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 invalid rolling schema resets continuity alone; invalid paths/fields cannot escape', async () => {
    for (const rolling of [{ version: 2 }, { ...record().rolling, sessionId: 'another-session-123' }, { ...record().rolling, activeTargets: ['../../outside'] }, { ...record().rolling, route: 'INVALID' }]) {
      const parsed = parseSavedSession({ ...record(), rolling })!; assert.equal(parsed.messages.length, 2); assert.equal(parsed.rolling, undefined);
    }
    const session = record(); session.messages[1].turn!.changedFiles.push('/etc/passwd', '../outside', 'file:secret', 'src/./a.ts');
    Object.assign(session.messages[1].turn!.tools[0], { target: '../outside', label: 'SECRET RAW LABEL', command: 'rm -rf /' });
    const parsed = parseSavedSession(session)!;
    assert.deepEqual(parsed.messages[1].turn!.changedFiles, ['src/a.ts']);
    assert.equal(parsed.messages[1].turn!.tools[0].target, undefined); assert.equal(parsed.messages[1].turn!.tools[0].label, 'Workspace tool');
    assert.equal(parsed.messages[1].turn!.tools[0].command, undefined);
    for (const value of [['assistant'], {}, null]) { const invalid = record(); (invalid.messages[1] as any).role = value; assert.equal(parseSavedSession(invalid), undefined); }
    for (const value of [['completed'], {}, null]) { const invalid = record(); (invalid.messages[1] as any).status = value; assert.equal(parseSavedSession(invalid), undefined); }
    for (const change of [{ schemaVersion: 4 }, { providerId: 'bad/provider' }, { sessionId: '../../file' }, { createdAt: 'bad' }, { execution: { autoOn: 'true' } }, { messages: [{ role: 'system', text: 'x' }] }]) assert.equal(parseSavedSession({ ...record(), ...change }), undefined);
  });
  await test('UI-05 interrupted turn/tool recovery retains partial text and only recorded successful changed files', async () => {
    const directory = await temp(); const store = new ChatSessionStore(directory); const session = record();
    session.messages[1].status = 'running'; session.messages[1].turn!.status = 'running';
    session.messages[1].turn!.tools.push({ id: 'tool-running-123', label: 'Create', target: 'unknown.ts', state: 'running' });
    try {
      await store.save(session); const f = chatFixture({ run: async () => { throw new Error('Should never run'); } }, new ChatSessionStore(directory));
      await f.adapter.initialize(); const message = f.adapter.snapshot()!.messages[1];
      assert.equal(message.status, 'interrupted'); assert.equal(message.turn!.status, 'interrupted'); assert.equal(message.text, session.messages[1].text);
      assert.equal(message.turn!.tools[1].state, 'interrupted'); assert.equal(message.turn!.tools[0].state, 'success');
      assert.deepEqual(message.turn!.changedFiles, ['src/a.ts']); assert.equal(f.adapter.snapshot()!.running, false); assert.equal(f.adapter.snapshot()!.status, 'Interrupted');
      f.dispose(); await store.flush();
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 restored Auto ON revalidates, forced OFF stays OFF after repair and persisted OFF stays OFF', async () => {
    for (const [on, valid] of [[true, true], [true, false], [false, true]]) {
      const directory = await temp(), store = new ChatSessionStore(directory); const session = record(); session.execution.autoOn = on; await store.save(session);
      const f = chatFixture(undefined, store); f.valid = valid;
      try {
        await f.adapter.initialize(); assert.equal(f.adapter.snapshot()!.autoOn, on && valid);
        f.valid = true; await f.monitor.refresh(); assert.equal(f.adapter.snapshot()!.autoOn, on && valid);
        await f.adapter.save(); assert.equal((await store.load(session.sessionId))!.execution.autoOn, on && valid);
      } finally { f.dispose(); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
    }
  });
  await test('UI-05 restored Manual missing model/unsupported effort has no fallback; disconnected history stays visible', async () => {
    for (const manual of [{ modelId: 'gone-model' }, { modelId: 'worker-id', effort: 'unsupported' }]) {
      const directory = await temp(), store = new ChatSessionStore(directory); const session = record(); session.execution = { autoOn: false, manual }; await store.save(session);
      let calls = 0; const f = chatFixture({ run: async () => { calls++; return {}; } }, store);
      try {
        await f.adapter.initialize(); assert.equal(f.adapter.snapshot()!.manualValid, false); assert.equal(f.adapter.snapshot()!.canSend, false);
        assert.equal(f.adapter.snapshot()!.manualModelId, manual.modelId); assert.equal(await f.message('chat/send', { text: 'blocked' }), false); assert.equal(calls, 0);
        f.connected = false; await f.monitor.refresh(); await f.controller.receive({ type: 'navigation/conversation' });
        assert.equal(f.controller.state().chat!.messages.length, 2); assert.equal(f.adapter.snapshot()!.canSend, false);
        f.connected = true; await f.monitor.refresh(); assert.equal(f.adapter.snapshot()!.messages[1].turn!.modelName, 'Captured Sol');
      } finally { f.dispose(); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
    }
  });
  await test('UI-05 switching while running cancels and settles, persists factual outcome, permits no concurrent turn', async () => {
    const directory = await temp(), store = new ChatSessionStore(directory); await store.save(record());
    let started!: () => void, settle!: () => void; const began = new Promise<void>(resolve => started = resolve), finish = new Promise<void>(resolve => settle = resolve);
    let calls = 0, cancelled = false; const f = chatFixture({ run: async (turn, emit) => {
      calls++; emit({ type: 'textDelta', text: 'partial' }); turn.token.onCancellationRequested(() => { cancelled = true; }); started(); await finish;
      emit({ type: 'cancellation' }); return {};
    } }, store);
    try {
      await f.start(); const activeId = f.adapter.snapshot()!.sessionId;
      const flight = f.message('chat/send', { text: 'running task' }); await began;
      const opening = f.controller.receive({ type: 'sessions/open', sessionId: 'session-history-123' });
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(cancelled, true); assert.equal(f.adapter.snapshot()!.sessionId, activeId);
      assert.equal(await f.message('chat/send', { text: 'no background' }), false); assert.equal(calls, 1);
      settle(); await flight; await opening;
      assert.equal(f.adapter.snapshot()!.sessionId, 'session-history-123');
      const old = (await store.load(activeId))!; assert.equal(old.messages[1].status, 'cancelled'); assert.equal(old.messages[1].text, 'partial');
    } finally { settle(); f.dispose(); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 individual deletion confirms, removes only selected store file and current transitions safely', async () => {
    const directory = await temp(), store = new ChatSessionStore(directory); await store.save(record('history-keep-one')); await store.save(record('history-delete-two'));
    let allow = false, confirmations = 0; const f = chatFixture(undefined, store, async () => { confirmations++; return allow; });
    const source = path.join(directory, 'source.txt'); await fs.writeFile(source, 'keep source');
    try {
      await f.adapter.initialize(); await f.controller.receive({ type: 'sessions/viewAll' });
      await f.controller.receive({ type: 'sessions/delete', sessionId: 'history-delete-two' }); assert.equal(store.list().length, 2);
      allow = true; await f.controller.receive({ type: 'sessions/delete', sessionId: 'history-delete-two' });
      assert.equal(confirmations, 2); assert.deepEqual(store.list().map(row => row.sessionId), ['history-keep-one']);
      assert.notEqual(f.adapter.snapshot()!.sessionId, 'history-delete-two'); assert.deepEqual(f.adapter.snapshot()!.messages, []);
      assert.equal((await f.controller.state().history!.items).length, 1); assert.equal(await fs.readFile(source, 'utf8'), 'keep source');
      await assert.rejects(fs.stat(path.join(directory, 'history-delete-two.json'))); assert.ok(await store.load('history-keep-one'));
    } finally { f.dispose(); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 strict history bridge rejects paths, extra fields, unknown providers and unbounded searches', async () => {
    for (const message of [{ type: 'sessions/open', sessionId: '../outside' }, { type: 'sessions/delete', sessionId: 'valid-session-123', path: '/etc' },
      { type: 'sessions/viewAll', extra: true }, { type: 'sessions/search', query: 'x', offset: -1 }, { type: 'sessions/search', query: 'x'.repeat(201), offset: 0 },
      { type: 'sessions/search', query: 'x', offset: 0, providerId: 'openai' }, { type: 'sessions/search', query: 'x' }, { type: 'sessions/open', sessionId: 'valid-session-123', command: 'run' }]) assert.equal(parseSidebarMessage(message, ['openai']), undefined);
    for (const message of [{ type: 'sessions/open', sessionId: 'valid-session-123' }, { type: 'sessions/delete', sessionId: 'valid-session-123' },
      { type: 'sessions/search', query: 'ภาษาไทย', offset: 0 }, { type: 'sessions/viewAll' }, { type: 'navigation/sessions' }]) assert.ok(parseSidebarMessage(message, ['openai']));
  });
  await test('UI-05 crash orphan recovery, defensive file bounds and symlink rejection preserve other history', async () => {
    const directory = await temp(); const store = new ChatSessionStore(directory);
    try {
      await store.save(record('history-indexed-one'));
      const orphan = record('history-orphan-two');
      await fs.writeFile(path.join(directory, `${orphan.sessionId}.json`), JSON.stringify(orphan));
      const oversized = path.join(directory, 'history-oversized-three.json');
      await fs.writeFile(oversized, ''); await fs.truncate(oversized, 32 * 1024 * 1024 + 1);
      await fs.symlink(path.join(directory, 'history-indexed-one.json'), path.join(directory, 'history-symlink-four.json'));
      const recovered = new ChatSessionStore(directory); await recovered.initialize();
      assert.deepEqual(new Set(recovered.list().map(row => row.sessionId)), new Set(['history-indexed-one', 'history-orphan-two']));
      assert.equal(await recovered.load('history-symlink-four'), undefined);
      assert.ok(await recovered.load('history-indexed-one')); assert.ok(await recovered.load('history-orphan-two'));
      assert.equal((await fs.stat(oversized)).size, 32 * 1024 * 1024 + 1, 'Bad files are preserved for recovery');
      const before = await fs.readFile(path.join(directory, 'history-indexed-one.json'), 'utf8');
      await store.save(record('history-indexed-one'));
      assert.equal(await fs.readFile(path.join(directory, 'history-indexed-one.json'), 'utf8'), before, 'Deterministic serialization');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  await test('UI-05 write coalescing keeps first/settled checkpoints and save failure retains old meaningful chat', async () => {
    const directory = await temp(), store = new ChatSessionStore(directory); let writes = 0; const save = store.save.bind(store);
    store.save = async session => { writes++; return save(session); };
    const f = chatFixture({ run: async (_turn, emit) => { for (let i = 0; i < 200; i++) emit({ type: 'textDelta', text: 'a' }); return {}; } }, store);
    try {
      await f.start(); writes = 0; await f.message('chat/send', { text: 'coalesced' }); assert.ok(writes <= 3, `${writes} writes for 200 deltas`);
      const id = f.adapter.snapshot()!.sessionId; assert.equal((await store.load(id))!.messages[1].text.length, 200);
      let lastBusy: boolean | undefined; const listener = f.controller.onDidChange(state => { lastBusy = state.busy; });
      store.save = async () => { throw new Error('RAW disk failure'); };
      assert.equal(await f.controller.receive({ type: 'chat/new' }), false); assert.equal(f.adapter.snapshot()!.sessionId, id);
      assert.equal(lastBusy, false, 'Failure publishes usable controls'); listener.dispose();
      assert.match(f.controller.state().notice!, /could not be saved/); assert.doesNotMatch(f.controller.state().notice!, /RAW/);
      store.save = save;
    } finally { f.dispose(); await store.flush(); await fs.rm(directory, { recursive: true, force: true }); }
  });
}
