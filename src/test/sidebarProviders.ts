import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { chatFixture } from './sidebarChat';
import { BoundaryFixtureProvider } from './providerFixture';
import { ProviderPicker } from '../sidebar/providerPicker';
import { NxProviderManager } from '../runtime/providers';
import { NxRuntime, NxUserTurn } from '../runtime/nxRuntime';
import { ContextSources } from '../runtime/contextSources';
import { referenceData, validateReferences } from '../runtime/references';
import { ChatSessionStore, parseSavedSession } from '../sidebar/sessionStore';
import { Telemetry } from '../telemetry';
import { parseSidebarMessage } from '../sidebar/state';

class Choices implements ProviderPicker {
  destination = 'boundary-fixture'; mode: 'fresh' | 'selected' | 'new' | 'cancel' = 'fresh'; consent = true;
  selected = [0]; prompts: string[] = [];
  async pick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Promise<T | undefined> {
    this.prompts.push(JSON.stringify({ items, options }));
    if (options.title?.startsWith('Switch provider')) return this.mode === 'cancel' ? undefined : items.find(item => (item as any).mode === this.mode);
    return items.find(item => (item as any).id === (options.title === 'New Chat provider' ? 'openai' : this.destination));
  }
  async many<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Promise<T[]> { this.prompts.push(JSON.stringify(options)); return this.selected.map(index => items[index]).filter(Boolean); }
  async confirm(message: string) { this.prompts.push(message); return this.consent; }
}
const setup = (runtime?: Pick<NxRuntime, 'run'>, store?: ChatSessionStore, context?: ContextSources) => {
  const b = new BoundaryFixtureProvider(), a = new BoundaryFixtureProvider('openai');
  const manager = new NxProviderManager([a, b]), picker = new Choices();
  const f = chatFixture(runtime, store, undefined, context, manager, picker);
  // The OpenAI UI fixture catalog is independently authoritative, matching its existing runtime mapping.
  return { ...f, b, a, manager, picker, switch: () => f.message('provider/openPicker') };
};
export async function sidebarProviderTests(test: (name: string, fn: () => Promise<void>) => Promise<void>) {
  await test('UI-07 ProviderManager discovery, one/multiple picker, exact bridge and production fixture exclusion', async () => {
    const single = chatFixture(); await single.start(); assert.equal(single.adapter.snapshot()!.providerPickerAvailable, false); single.dispose();
    const f = setup(); try {
      await f.start(); assert.equal(f.adapter.snapshot()!.providerPickerAvailable, true);
      assert.deepEqual(f.controller.state().linkedProviders?.map(provider => provider.label), ['Local openai', 'Local boundary-fixture']);
      const id = f.adapter.snapshot()!.sessionId;
      for (const extra of [{ providerId: 'boundary-fixture' }, { candidates: ['../../file'] }, { token: 'SECRET' }]) assert.equal(parseSidebarMessage({ type: 'provider/openPicker', sessionId: id, ...extra }, ['openai']), undefined);
      assert.equal(await f.controller.receive({ type: 'provider/openPicker', sessionId: 'stale-session-123' }), false);
      assert.equal(parseSidebarMessage({ type: 'provider/switch', sessionId: id, providerId: 'boundary-fixture' }, ['boundary-fixture']), undefined);
      const manifest = await fs.readFile(path.resolve(__dirname, '../../package.json'), 'utf8'); assert.doesNotMatch(manifest, /boundary-fixture|providerFixture|nx-spike/);
      const extension = await fs.readFile(path.resolve(__dirname, '../../src/extension.ts'), 'utf8'); assert.doesNotMatch(extension, /providerFixture|BoundaryFixtureProvider/);
    } finally { f.dispose(); }
  });
  await test('UI-07 native same provider or cancelled choice makes no boundary/request; fresh is first choice', async () => {
    const turns: NxUserTurn[] = [], f = setup({ run: async turn => { turns.push(turn); return {}; } });
    try { await f.start(); const id = f.adapter.snapshot()!.segments![0].id;
      f.picker.destination = 'openai'; await f.switch(); assert.equal(f.adapter.snapshot()!.segments!.length, 1);
      f.picker.destination = f.b.id; f.picker.mode = 'cancel'; await f.switch(); assert.equal(f.adapter.snapshot()!.segments![0].id, id);
      const prompt = JSON.parse(f.picker.prompts.at(-1)!); assert.equal(prompt.items[0].label, 'Continue fresh'); assert.match(prompt.items[0].description, /Do not send/);
      assert.equal(turns.length, 0); assert.equal(f.b.calls.length, 0);
    } finally { f.dispose(); }
  });
  await test('UI-07 Continue fresh resets rolling/internal state and sends only new segment conversation', async () => {
    const turns: NxUserTurn[] = [], f = setup({ run: async (turn, emit) => {
      turns.push(turn); emit({ type: 'model', providerId: turn.execution.providerId, modelId: turn.execution.providerId === 'openai' ? 'worker-id' : 'boundary-fixture-medium' });
      emit({ type: 'textDelta', text: turn.execution.providerId === 'openai' ? 'A_PRIVATE_ANSWER' : 'B answer' });
      return { metadata: { nxSessionState: { version: 1, sessionId: turn.sessionId!, currentObjective: 'A_PRIVATE_OBJECTIVE', activeTargets: [], recentActions: [], updatedAt: new Date().toISOString() } } };
    } });
    try {
      await f.start(); await f.message('chat/send', { text: 'A_PRIVATE_PROMPT' }); const before = f.adapter.snapshot()!;
      await f.switch(); const after = f.adapter.snapshot()!; assert.equal(after.sessionId, before.sessionId); assert.equal(after.segments!.length, 2);
      assert.notEqual(after.segments![1].id, before.segments![0].id); assert.equal(after.messages[1].turn!.providerId, 'openai');
      assert.equal(after.messages[1].turn!.modelName, 'worker-id'); assert.equal(after.segments![1].contextCarryMode, 'fresh');
      assert.equal(turns.length, 1); await f.message('chat/send', { text: 'New B request' });
      assert.equal(turns[1].execution.providerId, f.b.id); assert.equal(turns[1].previous, undefined); assert.deepEqual(turns[1].conversation, []); assert.deepEqual(turns[1].references, []);
      assert.doesNotMatch(JSON.stringify(turns[1]), /A_PRIVATE|response_id|encrypted/);
      await f.message('chat/send', { text: 'B followup' }); assert.equal(turns[2].conversation!.length, 2); assert.doesNotMatch(JSON.stringify(turns[2].conversation), /A_PRIVATE/);
    } finally { f.dispose(); }
  });
  await test('UI-07 Manual model/effort and Auto initialization are provider-local; OpenAI monitor cannot disable B', async () => {
    const f = setup(); try {
      await f.start(); await f.message('execution/setAuto', { on: false }); await f.message('execution/selectModel', { providerId: 'openai', modelId: 'worker-id' });
      f.b.valid = false; await f.switch(); assert.equal(f.adapter.snapshot()!.autoOn, false); assert.equal(f.adapter.snapshot()!.autoAvailable, false); assert.equal(f.adapter.snapshot()!.manualModelId, undefined);
      assert.equal(await f.message('execution/selectModel', { providerId: f.b.id, modelId: 'worker-id' }), false);
      assert.equal(await f.message('execution/selectModel', { providerId: f.b.id, modelId: 'boundary-fixture-medium' }), true, 'B Manual model');
      assert.equal(await f.message('execution/selectEffort', { effort: 'foreign-effort' }), false);
      assert.equal(await f.message('execution/selectEffort', { effort: 'fixture-effort' }), true, 'B effort');
      f.b.valid = true; await f.adapter.refreshProviders(); assert.equal(f.adapter.snapshot()!.autoOn, false);
      await f.message('execution/setAuto', { on: true });
      // Force OpenAI's state invalid independently of B.
      f.monitor.state()!.auto.available = false; f.executions.reconcile(false); f.adapter.reconcile(); assert.equal(f.adapter.snapshot()!.autoOn, true, 'B Auto after unrelated OpenAI reconciliation');
    } finally { f.dispose(); }
  });
  await test('UI-07 actual shared NxRuntime uses B Router/tier models and metadata; failure never calls A', async () => {
    const records: any[] = [], b = new BoundaryFixtureProvider(), a = new BoundaryFixtureProvider('openai');
    const manager = new NxProviderManager([a,b]); const picker = new Choices();
    const telemetry = { startSession: async () => {}, recordModel: async (r: any) => records.push(r), recordTool: async () => {}, recordTurn: async (r: any) => records.push(r) } as unknown as Telemetry;
    const f = chatFixture(new NxRuntime(telemetry, manager), undefined, undefined, undefined, manager, picker);
    try {
      await f.start(); await f.message('provider/openPicker'); await f.message('chat/send', { text: 'Explain project briefly' });
      assert.ok(b.calls.some(call => call.modelId.endsWith('-router'))); assert.ok(b.calls.some(call => call.modelId.endsWith('-medium'))); assert.equal(a.calls.length, 0);
      const record = records.find(record => record.provider_id); assert.equal(record.provider_id, b.id); assert.equal(record.provider_segment_id, f.adapter.snapshot()!.segments![1].id);
      assert.equal(record.manual_provider_switch, true); assert.equal(record.context_carry_mode, 'fresh'); assert.doesNotMatch(JSON.stringify(records), /Explain project briefly|Answer from/);
      b.nextPart = new vscode.LanguageModelToolCallPart('denied-deploy', 'nx_execute', { command: 'npm', args: ['run', 'deploy'] });
      await f.message('chat/send', { text: 'Inspect local files briefly' });
      assert.ok(b.calls.some(call => call.modelId.endsWith('-high')), 'Dynamic escalation uses B HIGH only');
      assert.equal(a.calls.length, 0); assert.equal(f.adapter.snapshot()!.messages.at(-1)!.turn!.tools[0].state, 'rejected');
      b.fail = true; await f.message('chat/send', { text: 'Read-only followup' }); assert.equal(a.calls.length, 0); assert.equal(f.adapter.snapshot()!.providerId, b.id);
      b.connected = false; await f.adapter.refreshProviders(); assert.equal(f.adapter.snapshot()!.canSend, false); assert.equal(f.adapter.snapshot()!.providerId, b.id);
    } finally { f.dispose(); }
  });
  await test('UI-07 selected carry requires named consent, rematerializes only selected NxReferences as DATA', async () => {
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'ui07-safe.txt'); await vscode.workspace.fs.writeFile(file, Buffer.from('NEW_FILE_DATA'));
    const turns: NxUserTurn[] = [], f = setup({ run: async turn => { turns.push(turn); return {}; } });
    try {
      await f.start(); await f.message('chat/send', { text: 'A private transcript' });
      // Historical descriptors are safe candidates, never source snapshots/grants.
      (f.adapter as any).session.messages[0].references = [{ kind: 'file', path: 'ui07-safe.txt' }, { kind: 'file', path: 'NOT_SELECTED.txt' }];
      f.picker.mode = 'selected'; f.picker.consent = false; await f.switch(); assert.equal(f.adapter.snapshot()!.providerId, 'openai');
      f.picker.consent = true; await f.switch(); assert.match(f.picker.prompts.at(-1)!, /Selected context will be sent to Local boundary-fixture.*ui07-safe.txt/);
      assert.equal(turns.length, 1); assert.equal(f.adapter.snapshot()!.draftContext!.length, 1);
      await f.message('chat/send', { text: 'Use selected context' }); assert.equal(turns[1].references.length, 1); assert.equal(turns[1].references[0].content, 'NEW_FILE_DATA');
      assert.equal(turns[1].references[0].crossProvider!.originProviderId, 'openai'); assert.match(referenceData(turns[1].references), /untrusted DATA/);
      assert.doesNotMatch(JSON.stringify(turns[1]), /NOT_SELECTED|A private transcript|accessToken|encrypted_reasoning|response_id/);
      assert.equal(f.adapter.snapshot()!.segments![1].carryCount, 1); assert.equal(f.adapter.snapshot()!.draftContext!.length, 0);
    } finally { f.dispose(); await vscode.workspace.fs.delete(file); }
  });
  await test('UI-07 fresh preserves explicitly selected unsent draft file/selection and never resends sent context', async () => {
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'ui07-draft.txt');
    await vscode.workspace.fs.writeFile(file, Buffer.from('safe draft file'));
    const document = await vscode.workspace.openTextDocument(file), editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0,0,0,4);
    let kind = 'Current selection';
    const context = new ContextSources({ choose: async () => kind, files: async () => undefined, editor: () => editor });
    const turns: NxUserTurn[] = [], f = setup({ run: async turn => { turns.push(turn); return {}; } }, undefined, context);
    try {
      await f.start(); await f.message('context/openPicker'); const before = f.adapter.snapshot()!.draftContext!;
      await f.switch(); assert.equal(turns.length, 0); assert.deepEqual(f.adapter.snapshot()!.draftContext, before);
      await f.message('chat/send', { text: 'Draft text now belongs to B' }); assert.equal(turns.length, 1);
      assert.equal(turns[0].execution.providerId, f.b.id); assert.equal(turns[0].references[0].content, 'safe');
      assert.equal(turns[0].references[0].crossProvider!.originProviderId, 'openai');
      assert.equal(f.adapter.snapshot()!.draftContext!.length, 0);
      await f.message('chat/send', { text: 'No implicit resend' }); assert.deepEqual(turns[1].references, []);
      // History alone cannot recreate a selection snapshot.
      assert.equal((f.adapter as any).carryCandidates().length, 0);
    } finally { f.dispose(); await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); await vscode.workspace.fs.delete(file); }
  });
  await test('UI-07 selected carry excludes unchecked draft items after explicit discard consent', async () => {
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'ui07-selected-draft.txt'); await vscode.workspace.fs.writeFile(file, Buffer.from('safe selected draft'));
    const document = await vscode.workspace.openTextDocument(file), editor = await vscode.window.showTextDocument(document); editor.selection = new vscode.Selection(0,0,0,4);
    let kind = 'Current file'; const context = new ContextSources({ choose: async () => kind, files: async () => undefined, editor: () => editor });
    const turns: NxUserTurn[] = [], f = setup({ run: async turn => { turns.push(turn); return {}; } }, undefined, context);
    try { await f.start(); await f.message('context/openPicker'); kind = 'Current selection'; await f.message('context/openPicker'); assert.equal(f.adapter.snapshot()!.draftContext!.length, 2);
      f.picker.mode = 'selected'; f.picker.selected = [1]; await f.switch();
      assert.match(f.picker.prompts.at(-1)!, /Unselected draft attachments will be removed; draft text stays/);
      assert.equal(f.adapter.snapshot()!.draftContext!.length, 1); assert.equal(f.adapter.snapshot()!.draftContext![0].descriptor.kind, 'selection');
      await f.message('chat/send', { text: 'Use exactly selected context' }); assert.equal(turns[0].references.length, 1); assert.equal(turns[0].references[0].content, 'safe');
      assert.equal(turns[0].references[0].descriptor.kind, 'selection');
    } finally { f.dispose(); await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); await vscode.workspace.fs.delete(file); }
  });
  await test('UI-07 missing carried source blocks next Send factually and budgets remain enforced', async () => {
    let calls = 0; const f = setup({ run: async () => { calls++; return {}; } });
    try {
      await f.start(); await f.message('chat/send', { text: 'First' }); (f.adapter as any).session.messages[0].references = [{ kind: 'file', path: 'missing-ui07.txt' }];
      f.picker.mode = 'selected'; await f.switch(); assert.equal(await f.message('chat/send', { text: 'Retain draft' }), false);
      assert.equal(calls, 1); assert.equal(f.adapter.snapshot()!.draftContext!.length, 1); assert.match(f.adapter.snapshot()!.contextNotice!, /unavailable|context|exist/i);
      assert.throws(() => validateReferences(Array.from({ length: 9 }, () => ({ descriptor: { kind: 'file', path: 'a.txt' }, provenance: 'current_file', crossProvider: { originProviderId: 'openai', originProviderLabel: 'OpenAI' }, content: 'safe' })) as any), /8 context/);
      assert.throws(() => validateReferences([{ descriptor: { kind: 'file', path: 'a.txt' }, provenance: 'current_file', content: 'x'.repeat(16001), crossProvider: { originProviderId: 'openai', originProviderLabel: 'OpenAI' } }]), /16,000/);
    } finally { f.dispose(); }
  });
  await test('UI-07 Start new chat uses selected provider with new IDs/no context and preserves draft intent', async () => {
    const f = setup(); try { await f.start(); await f.message('chat/send', { text: 'Saved previous session' }); const old = f.adapter.snapshot()!;
      f.picker.mode = 'new'; await f.switch(); const next = f.adapter.snapshot()!; assert.notEqual(next.sessionId, old.sessionId); assert.equal(next.providerId, f.b.id);
      assert.equal(next.preserveDraftFromSessionId, old.sessionId); assert.equal(next.segments!.length, 1); assert.deepEqual(next.messages, []); assert.deepEqual(next.draftContext, []); assert.equal(next.manualModelId, undefined); assert.equal(f.b.calls.length, 0);
    } finally { f.dispose(); }
  });
  await test('UI-07 active switch cancels and waits, retains factual output and never retries cancelled prompt', async () => {
    let entered!: () => void; const started = new Promise<void>(r => entered = r); const turns: NxUserTurn[] = [];
    const f = setup({ run: async (turn, emit) => { turns.push(turn); emit({ type: 'textDelta', text: 'Partial A' }); entered();
      await new Promise<void>(resolve => turn.token.onCancellationRequested(() => resolve())); emit({ type: 'cancellation' }); return {}; } });
    try { await f.start(); const sending = f.message('chat/send', { text: 'Cancel me' }); await started; await f.switch(); await sending;
      assert.equal(turns.length, 1); assert.equal(turns[0].token.isCancellationRequested, true); assert.equal(f.adapter.snapshot()!.messages[1].status, 'cancelled'); assert.equal(f.adapter.snapshot()!.messages[1].text, 'Partial A'); assert.equal(f.adapter.snapshot()!.running, false); assert.equal(f.b.calls.length, 0);
    } finally { f.dispose(); }
  });
  await test('UI-07 schema v3 durable boundary restore/open/search makes zero requests and unavailable current remains factual', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui07-')); const store = new ChatSessionStore(dir); const turns: NxUserTurn[] = [];
    const f = setup({ run: async turn => { turns.push(turn); return {}; } }, store);
    try {
      await f.start(); await f.message('chat/send', { text: 'A history' }); await f.switch(); await f.message('chat/send', { text: 'B history' }); const before = f.adapter.snapshot()!;
      await f.adapter.shutdown(); const persisted = JSON.parse(await fs.readFile(path.join(dir, `${before.sessionId}.json`), 'utf8'));
      assert.equal(persisted.schemaVersion, 3); assert.equal(persisted.segments.length, 2); assert.doesNotMatch(JSON.stringify(persisted), /crossProvider|responseMetadata|snapshot|accessToken/);
      let requests = 0; const second = setup({ run: async turn => { requests++; assert.doesNotMatch(JSON.stringify(turn.conversation), /A history/); return {}; } }, new ChatSessionStore(dir));
      try { second.b.connected = false; await second.adapter.initialize(); await second.adapter.open(before.sessionId); await second.adapter.search('history');
        assert.equal(requests, 0); assert.equal(second.adapter.snapshot()!.providerId, second.b.id); assert.equal(second.adapter.snapshot()!.canSend, false); assert.equal(second.adapter.snapshot()!.segments!.length, 2);
        second.b.connected = true; await second.adapter.refreshProviders(); await second.adapter.setAuto(true); await second.message('chat/send', { text: 'Continue B' }); assert.equal(requests, 1);
        second.b.connected = false; await second.adapter.refreshProviders(); second.picker.destination = 'openai'; await second.switch(); assert.equal(second.adapter.snapshot()!.segments!.length, 3);
      } finally { second.dispose(); }
      for (const version of [1,2]) { const legacy = { ...persisted, schemaVersion: version, segments: undefined, providerId: 'openai', segmentId: persisted.segments[0].id, messages: persisted.messages.slice(0,2).map((message: any) => ({ ...message, segmentId: undefined })) }; const parsed = parseSavedSession(legacy)!; assert.equal(parsed.segments!.length, 1); assert.equal(parsed.providerId, 'openai'); }
      const damaged = parseSavedSession({ ...persisted, segments: [{ invalid: true }] })!; assert.equal(damaged.messages.length, 4); assert.equal(damaged.segments!.length, 2); assert.equal(damaged.rolling, undefined);
    } finally { f.dispose(); await store.flush(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  await test('UI-07 unsent selected carry after restart blocks Send without descriptor reads until explicit reselection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui07-pending-'));
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'ui07-pending.txt'); await vscode.workspace.fs.writeFile(file, Buffer.from('Pending safe data'));
    const f = setup(undefined, new ChatSessionStore(dir));
    try {
      await f.start(); await f.message('chat/send', { text: 'Previous provider message' });
      (f.adapter as any).session.messages[0].references = [{ kind: 'file', path: 'ui07-pending.txt' }];
      f.picker.mode = 'selected'; await f.switch(); await f.adapter.shutdown(); const id = f.adapter.snapshot()!.sessionId;
      let calls = 0; const second = setup({ run: async () => { calls++; return {}; } }, new ChatSessionStore(dir));
      try { await second.adapter.initialize(); await second.adapter.open(id);
        assert.equal(calls, 0); assert.equal(second.adapter.snapshot()!.canSend, false); assert.match(second.adapter.snapshot()!.contextNotice!, /not retained after reload/);
        assert.deepEqual(second.adapter.snapshot()!.draftContext, []); assert.equal(await second.message('chat/send', { text: 'Blocked without carry reselection' }), false);
        await second.message('context/clear'); assert.equal(second.adapter.snapshot()!.canSend, true, 'Explicit discard permits a fresh request');
      } finally { second.dispose(); }
    } finally { f.dispose(); await vscode.workspace.fs.delete(file); await fs.rm(dir, { recursive: true, force: true }); }
  });
  await test('UI-07 recoverable index failure does not report a durable boundary as failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui07-index-')), store = new ChatSessionStore(dir), f = setup(undefined, store);
    try { await f.start(); await f.message('chat/send', { text: 'Session before boundary' });
      const atomic = (store as any).atomic.bind(store);
      (store as any).atomic = async (file: string, value: unknown) => { if (file.endsWith('index.json')) throw new Error('Index failed'); return atomic(file,value); };
      assert.equal(await f.switch(), true); assert.equal(f.adapter.snapshot()!.providerId, f.b.id); assert.equal(f.adapter.persistenceNotice, undefined);
      const recovered = new ChatSessionStore(dir); await recovered.initialize();
      assert.equal((await recovered.load(f.adapter.snapshot()!.sessionId))!.providerId, f.b.id);
    } finally { f.dispose(); await store.flush(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  await test('UI-07 shutdown during boundary commit never overwrites the durable new segment with old state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui07-shutdown-')), store = new ChatSessionStore(dir), f = setup(undefined, store);
    let reached!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => reached = resolve), gate = new Promise<void>(resolve => release = resolve);
    try { await f.start(); await f.message('chat/send', { text: 'Durable previous segment' });
      const atomic = (store as any).atomic.bind(store);
      (store as any).atomic = async (file: string, value: any) => { if (value.providerId === f.b.id) { reached(); await gate; } return atomic(file,value); };
      const switching = f.switch(); await started;
      const shutdown = f.adapter.shutdown(); release(); await switching; await shutdown;
      const saved = (await new ChatSessionStore(dir).load(f.adapter.snapshot()!.sessionId))!;
      assert.equal(saved.providerId, f.b.id); assert.equal(saved.segments!.length, 2);
    } finally { release?.(); f.dispose(); await store.flush(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  await test('UI-07 switch storage failure never activates a half-created in-memory segment', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui07-save-')); const store = new ChatSessionStore(dir); const f = setup(undefined, store);
    try { await f.start(); await f.message('chat/send', { text: 'Durable A' }); const save = store.save.bind(store);
      store.save = async session => { if (session.providerId !== 'openai') throw new Error('Disk failed'); return save(session); };
      assert.equal(await f.switch(), false); assert.equal(f.adapter.snapshot()!.providerId, 'openai'); assert.equal(f.adapter.snapshot()!.segments!.length, 1); assert.match(f.adapter.persistenceNotice!, /saved locally/);
    } finally { f.dispose(); await store.flush(); await fs.rm(dir, { recursive: true, force: true }); }
  });
}
