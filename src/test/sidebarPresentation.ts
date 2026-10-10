import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { chatFixture } from './sidebarChat';
import { toolActivity, appliedTargets, workspaceIdentity } from '../worker/toolActivity';
import { parseSidebarMessage, safeExternalLink } from '../sidebar/state';
import { ProductionTool, NxToolResult } from '../worker/productionTools';
import { DiffContent } from '../workspace';
import { runWorkerLoop, WorkerToolEvent } from '../worker/workerLoop';

export async function sidebarPresentationTests(test: (name: string, fn: () => Promise<void>) => Promise<void>): Promise<void> {
  await test('UI-04 normalized tool metadata excludes source, args, search terms, credentials and raw summaries', async () => {
    assert.deepEqual(toolActivity('nx_read', { path: 'src/./router.ts', startLine: 2, endLine: 12, content: 'PRIVATE_SOURCE' }),
      { label: 'Read', target: 'src/router.ts', lineRange: '2–12' });
    assert.deepEqual(toolActivity('nx_execute', { command: 'npm', args: ['test'], stdout: 'PRIVATE_OUTPUT' }), { label: 'npm test', command: 'npm test' });
    for (const [tool, input] of [['nx_search', { query: 'TOKEN_SECRET', include: '*.ts' }],
      ['nx_execute', { command: 'phpunit', args: ['TOKEN_SECRET'] }], ['nx_read', { path: '/private/TOKEN_SECRET' }],
      ['TOKEN_SECRET', { raw: 'TOKEN_SECRET' }]] as const) assert.doesNotMatch(JSON.stringify(toolActivity(tool, input)), /TOKEN_SECRET|raw|query|include/);
    for (const path of ['/etc/passwd', '../escape', 'src/../escape', 'C:\\private', 'nx-router-diff:foo', 'a\nfile']) assert.equal(workspaceIdentity(path), undefined);
    assert.equal(workspaceIdentity('src\\.\\a.ts'), 'src/a.ts');
  });
  await test('UI-04 applied targets count successful production mutations only, normalize and include both move identities', async () => {
    const data = { success: true, summary: 'PRIVATE', structuredData: { path: 'src/./after.ts', source: 'src/before.ts', stdout: 'PRIVATE' } };
    assert.deepEqual(appliedTargets('nx_move_file', data), ['src/after.ts', 'src/before.ts']);
    assert.deepEqual(appliedTargets('nx_copy_file', data), ['src/after.ts']);
    assert.deepEqual(appliedTargets('nx_read', data), []);
    assert.deepEqual(appliedTargets('nx_edit_file', { ...data, structuredData: { path: 'same.ts', changed: false } }), []);
    for (const change of [{ success: false }, { rejected: true }, { cancelled: true }]) assert.deepEqual(appliedTargets('nx_edit_file', { ...data, ...change }), []);
    assert.deepEqual(appliedTargets('nx_edit_file', { ...data, structuredData: { path: '../escape' } }), []);
  });
  await test('UI-04 real production mutation results exclude no-op/rejected edits and report move/copy identities', async () => {
    const token = new vscode.CancellationTokenSource();
    const root = vscode.workspace.workspaceFolders![0].uri;
    const dir = vscode.Uri.joinPath(root, 'ui04-mutations'); await vscode.workspace.fs.createDirectory(dir);
    const invoke = async (name: 'nx_create_file' | 'nx_edit_file' | 'nx_copy_file' | 'nx_move_file', input: Record<string, unknown>, approve = true) => {
      const result = await new ProductionTool(name, new DiffContent(), async () => approve).invoke({ input, toolInvocationToken: undefined }, token.token);
      return JSON.parse((result.content[0] as vscode.LanguageModelTextPart).value) as NxToolResult;
    };
    try {
      const created = await invoke('nx_create_file', { path: 'ui04-mutations/a.txt', content: 'same' });
      assert.deepEqual(appliedTargets('nx_create_file', created), ['ui04-mutations/a.txt']);
      const edits = [{ range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4 }, expectedText: 'same', text: 'same' }];
      const unchanged = await invoke('nx_edit_file', { path: 'ui04-mutations/a.txt', edits });
      assert.equal(unchanged.success, true); assert.deepEqual(appliedTargets('nx_edit_file', unchanged), []);
      const rejected = await invoke('nx_edit_file', { path: 'ui04-mutations/a.txt', edits: [{ ...edits[0], text: 'new' }] }, false);
      assert.equal(rejected.rejected, true); assert.deepEqual(appliedTargets('nx_edit_file', rejected), []);
      const copied = await invoke('nx_copy_file', { source: 'ui04-mutations/a.txt', destination: 'ui04-mutations/b.txt' });
      assert.deepEqual(appliedTargets('nx_copy_file', copied), ['ui04-mutations/b.txt']);
      const moved = await invoke('nx_move_file', { source: 'ui04-mutations/b.txt', destination: 'ui04-mutations/c.txt' });
      assert.deepEqual(appliedTargets('nx_move_file', moved), ['ui04-mutations/c.txt', 'ui04-mutations/b.txt']);
    } finally { token.dispose(); await vscode.workspace.fs.delete(dir, { recursive: true }); }
  });
  await test('UI-04 runtime-backed per-turn presentation preserves actual execution after next-turn control changes', async () => {
    const f = chatFixture({ run: async (_turn, emit) => {
      emit({ type: 'route', route: 'MEDIUM' }); emit({ type: 'model', providerId: 'openai', modelId: 'worker-id' });
      emit({ type: 'escalation', from: 'MEDIUM', to: 'HIGH', completed: true });
      emit({ type: 'model', providerId: 'openai', modelId: 'high-id' });
      emit({ type: 'textDelta', text: 'An answer' }); emit({ type: 'completion', status: 'completed', finalRoute: 'HIGH' }); return {};
    } });
    f.models = f.models.map(model => ({ ...model, name: `Trusted ${model.id}` }));
    try {
      await f.start(); await f.message('chat/send', { text: 'question' });
      const old = f.adapter.snapshot()!.messages[1].turn!;
      assert.equal(old.mode, 'auto'); assert.equal(old.route, 'HIGH'); assert.equal(old.modelName, 'Trusted high-id');
      assert.match(f.adapter.snapshot()!.executionLabel!, /↑ MEDIUM → HIGH · Trusted high-id/);
      assert.doesNotMatch(f.adapter.snapshot()!.executionLabel!, /Default/);
      await f.message('execution/setAuto', { on: false });
      await f.message('execution/selectModel', { providerId: 'openai', modelId: 'worker-id' });
      assert.deepEqual(f.adapter.snapshot()!.messages[1].turn, old);
      await f.message('chat/send', { text: 'next' }); assert.deepEqual(f.adapter.snapshot()!.messages[1].turn, old);
    } finally { f.dispose(); }
  });
  await test('UI-04 truthful outcomes, safe expanded metadata, deduplicated applied files and no invented line deltas', async () => {
    const f = chatFixture({ run: async (_turn, emit) => {
      for (const outcome of ['success', 'rejected', 'failed', 'cancelled', 'invalid']) {
        emit({ type: 'toolStart', tool: 'nx_edit_file', activity: { label: 'PRIVATE_RAW', target: 'src/./router.ts' } });
        emit({ type: 'toolResult', tool: 'nx_edit_file', outcome, durationMs: 12.2, changedTargets: ['src/router.ts', 'src/./router.ts', '../escape'] });
      }
      emit({ type: 'toolResult', tool: 'nx_read', outcome: 'success', changedTargets: ['fake.ts'] });
      emit({ type: 'completion', status: 'partial', finalRoute: 'MEDIUM' }); return {};
    } });
    try {
      await f.start(); await f.message('chat/send', { text: 'question' });
      const turn = f.adapter.snapshot()!.messages[1].turn!;
      assert.deepEqual(turn.changedFiles, ['src/router.ts']);
      assert.deepEqual(turn.tools.map(tool => tool.state), ['success', 'rejected', 'failed', 'cancelled', 'failed', 'success']);
      assert.equal(turn.tools[0].label, 'Edit'); assert.equal(turn.tools[0].target, 'src/router.ts'); assert.equal(turn.tools[0].durationMs, 12);
      assert.equal(turn.status, 'partial');
      assert.doesNotMatch(JSON.stringify(f.controller.state()), /PRIVATE|structuredData|stdout|stderr|arguments|nx_edit_file|lineDelta|additions|deletions|Waiting for/);
    } finally { f.dispose(); }
  });
  await test('UI-04 terminal states and unfinished tools finalize honestly, failed escalation keeps actual model', async () => {
    for (const status of ['completed', 'partial', 'cancelled', 'failed'] as const) {
      const f = chatFixture({ run: async (_turn, emit) => {
        emit({ type: 'route', route: 'MEDIUM' }); emit({ type: 'model', providerId: 'openai', modelId: 'worker-id' });
        emit({ type: 'escalation', from: 'MEDIUM', to: 'HIGH', completed: false });
        emit({ type: 'toolStart', tool: 'nx_read' }); emit({ type: 'completion', status, finalRoute: 'MEDIUM' }); return {};
      } });
      try {
        await f.start(); await f.message('chat/send', { text: 'question' });
        const state = f.adapter.snapshot()!;
        assert.equal(state.messages[1].turn!.status, status); assert.equal(state.messages[1].turn!.modelId, 'worker-id');
        assert.equal(state.messages[1].turn!.tools[0].state, status === 'cancelled' ? 'cancelled' : 'failed');
        assert.match(state.executionLabel!, /MEDIUM · worker-id · Escalation unavailable/);
        assert.doesNotMatch(state.executionLabel!, /↑|Default/);
      } finally { f.dispose(); }
    }
  });
  await test('UI-04 external links and clipboard use exact narrow host messages; dangerous protocols never pass', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'command:workbench.action.closeWindow', 'file:///etc/passwd',
      'vscode://command', '//example.org', 'https://user:secret@example.org', 'https://example.org/\npath', 'https://example.org path']) {
      assert.equal(safeExternalLink(url), undefined); assert.equal(parseSidebarMessage({ type: 'link/open', url }, ['openai']), undefined);
    }
    assert.ok(parseSidebarMessage({ type: 'link/open', url: 'https://example.org/path' }, ['openai']));
    for (const message of [{ type: 'link/open', url: 'https://example.org', command: 'bad' },
      { type: 'clipboard/copy', text: 'code', requestId: 1, extra: true }, { type: 'clipboard/copy', text: {}, requestId: 1 },
      { type: 'clipboard/copy', text: 'code', requestId: -1 }]) assert.equal(parseSidebarMessage(message, ['openai']), undefined);
    const f = chatFixture();
    try {
      const response = '# Full response\n\nคำตอบ **พร้อม Markdown**\n\n```ts\nconst result = 1;\n```\n';
      await f.start(); assert.equal(await f.controller.receive({ type: 'clipboard/copy', text: response, requestId: 1 }), true);
      assert.equal(await vscode.env.clipboard.readText(), response);
    } finally { f.dispose(); }
  });
  await test('UI-04 shared worker emits applied change even when cancellation arrives after successful mutation', async () => {
    const token = new vscode.CancellationTokenSource(); const events: WorkerToolEvent[] = [];
    await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', false, vscode.ConfigurationTarget.Workspace);
    try {
      const result = await runWorkerLoop({ route: 'MEDIUM', task: { userPrompt: 'edit file' }, normalizedTask: 'edit file', references: [], token: token.token,
        stream: () => {}, onModelRequest: async (_model, _messages, run) => run(), onToolEvent: async event => { events.push(event); },
        selectModel: async () => ({ async sendRequest() { return { stream: (async function* () { yield new vscode.LanguageModelToolCallPart('edit', 'nx_edit_file', { path: 'changed.ts', edits: [] }); })() }; } }) as unknown as vscode.LanguageModelChat,
        invokeTool: async () => { token.cancel(); return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify({ success: true, summary: 'PRIVATE', structuredData: { path: 'changed.ts' } }))]); } });
      assert.equal(result.status, 'cancelled'); assert.deepEqual(result.changedTargets, ['changed.ts']);
      assert.equal(events[0].outcome, 'success'); assert.deepEqual(events[0].changedTargets, ['changed.ts']);
      assert.deepEqual(events[0].activity, { label: 'Edit', target: 'changed.ts' });
    } finally { token.dispose(); await vscode.workspace.getConfiguration('nxRouter.worker').update('fixtureModels', true, vscode.ConfigurationTarget.Workspace); }
  });
}
