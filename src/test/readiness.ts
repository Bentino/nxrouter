import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Telemetry, newId, pricing } from '../telemetry';
import { createVsCodeEnricher } from '../enrichment';
import { NxRuntime } from '../runtime/nxRuntime';
import { NxProviderManager, NxProvider, NxProviderProfile } from '../runtime/providers';
import { ChatSessionStore } from '../sidebar/sessionStore';

export async function readinessTests(test: (name: string, run: () => Promise<void>) => Promise<void>): Promise<void> {
  await test('UI-08 telemetry unknown/partial usage is unavailable; resumed identity survives clear/retention', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui08-telemetry-'));
    const settings = vscode.workspace.getConfiguration('nxRouter.telemetry');
    const oldEnabled = settings.inspect('enabled')?.workspaceValue;
    const local = new Telemetry({ globalStorageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext);
    const session = newId(), foreign = newId(), at = new Date().toISOString();
    try {
      await settings.update('enabled', true, vscode.ConfigurationTarget.Workspace);
      await local.startSession(session); await local.startSession(session);
      const record = { session_id: session, turn_id: newId(), request_id: newId(), role: 'worker' as const, provider: 'openai', model: 'ui08', duration_ms: 1, success: true, at };
      await local.recordModel(record);
      let data = await local.export(session) as any;
      assert.equal(data.summary.sessions, 1); assert.equal(data.summary.observed_input_tokens, null);
      assert.equal(data.summary.input_token_unavailable_requests, 1); assert.equal(data.schemaVersion, 1);
      assert.match(data.tokenMeasurement, /not_provider_usage/);
      await local.recordModel({ ...record, request_id: newId(), observed_input_tokens: 0, observed_output_tokens: 3, estimated_api_equivalent_cost_usd: 0.01 });
      data = await local.export(session) as any;
      assert.equal(data.summary.observed_input_tokens, 0); assert.equal(data.summary.input_token_unavailable_requests, 1);
      assert.equal(data.summary.estimated_api_equivalent_cost_usd, null, 'Partial known cost is not a total');
      await local.clear(session);
      // A resumed real turn recreates identity; queued workspace clear must include it.
      const start = local.startSession(session), model = local.recordModel(record);
      await local.append('sessions', { session_id: foreign, workspace_id: 'foreign', at });
      await local.clear(undefined, true); await Promise.all([start, model]);
      assert.equal((await local.export(session) as any).modelRequests.length, 0);
      assert.equal((await local.export(foreign) as any).sessions.length, 1);
      await settings.update('enabled', false, vscode.ConfigurationTarget.Workspace);
      await local.startSession(session); await local.recordModel(record);
      assert.equal((await local.export(session) as any).sessions.length, 0);
      assert.deepEqual(pricing, {});
    } finally { await settings.update('enabled', oldEnabled, vscode.ConfigurationTarget.Workspace); await fs.rm(dir, { recursive: true, force: true }); }
  });
  await test('UI-08 enrichment refuses an editor reference through an escaping symlink', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const external = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui08-external-'));
    const link = vscode.Uri.joinPath(root, 'ui08-escape.txt');
    try {
      await fs.writeFile(path.join(external, 'secret.txt'), 'existing_records=999 UI08_PRIVATE_SENTINEL');
      await fs.symlink(path.join(external, 'secret.txt'), link.fsPath);
      const enrich = createVsCodeEnricher([{ id: 'ui08', value: link } as vscode.ChatPromptReference]);
      const result = await enrich({ userPrompt: 'Investigate storage', references: [] }, [{ kind: 'existing_data', reason: 'Check records' } as any]);
      assert.equal(result.inspectedFiles, 0); assert.ok(result.failure);
      assert.equal(result.evidence.existingRecords, undefined); assert.doesNotMatch(JSON.stringify(result), /UI08_PRIVATE_SENTINEL/);
    } finally { await fs.rm(link.fsPath, { force: true }); await fs.rm(external, { recursive: true, force: true }); }
  });
  await test('UI-08 cancelled Router request remains factual in turn and model accounting', async () => {
    const source = new vscode.CancellationTokenSource(), requests: any[] = [], turns: any[] = [];
    const profile: NxProviderProfile = { providerId: 'openai', auto: { router: { modelId: 'router' }, tiers: { LOW: { modelId: 'worker' }, MEDIUM: { modelId: 'worker' }, HIGH: { modelId: 'worker' } } } };
    const provider: NxProvider = { id: 'openai', label: 'Local OpenAI', connectionStatus: async () => 'connected', listModels: async () => [],
      resolveModel: async () => ({ id: 'router', vendor: 'openai', countTokens: async () => { throw Error('unavailable'); },
        sendRequest: async () => { source.cancel(); throw new vscode.CancellationError(); } } as unknown as vscode.LanguageModelChat) };
    const telemetry = { startSession: async () => {}, recordModel: async (value: any) => { requests.push(value); }, recordTurn: async (value: any) => { turns.push(value); }, recordTool: async () => {} } as unknown as Telemetry;
    try {
      await new NxRuntime(telemetry, new NxProviderManager([provider])).run({ sessionId: newId(), text: 'Inspect local fixture', references: [], execution: { mode: 'auto', providerId: 'openai' }, profile, token: source.token }, () => {});
      assert.equal(requests.length, 1); assert.equal(requests[0].role, 'router'); assert.equal(requests[0].success, false);
      assert.equal(turns.length, 1); assert.equal(turns[0].status, 'cancelled'); assert.equal(turns[0].router_request_count, 1);
    } finally { source.dispose(); }
  });
  await test('UI-08 bounded history performance observation without inference', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-ui08-history-'));
    const store = new ChatSessionStore(dir), now = new Date().toISOString();
    try {
      for (let i = 0; i < 200; i++) await store.save({ sessionId: `ui08-session-${i}`, segmentId: `ui08-segment-${i}`, providerId: 'openai', title: `Bounded fixture ${i}`, createdAt: now, updatedAt: now,
        execution: { autoOn: false }, messages: [{ id: `ui08-user-${i}`, role: 'user', text: `Needle ${i}`, createdAt: now }] });
      const restored = new ChatSessionStore(dir);
      const start = performance.now(); await restored.initialize(); const initialized = performance.now();
      assert.equal(restored.list().length, 6); const page = await restored.search('Needle 199'); const searched = performance.now();
      assert.equal(page.items.length, 1);
      const output = path.resolve(__dirname, '../../.test-results/ui08-performance.json');
      await fs.writeFile(output, JSON.stringify({ kind: 'deterministic-disposable-history', sessions: 200, indexLoadMs: initialized - start, searchMs: searched - initialized, inferenceRequests: 0, arbitrarySlo: false }, null, 2));
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}
