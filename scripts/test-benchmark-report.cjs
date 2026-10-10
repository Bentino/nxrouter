const { test } = require('node:test');
const assert = require('node:assert/strict');
const { report, markdown } = require('./benchmark-report.cjs');
function fixture() {
  const configuration = { providerId: 'openai', baseline: { commit: 'synthetic', fixtureSha256: 'synthetic-fixture', workspaceSha256: 'synthetic-workspace' }, environment: { node: 'synthetic', vscode: 'synthetic', platform: 'synthetic' }, extension: { version: 'synthetic', sha256: 'synthetic' }, catalog: ['r', 'low', 'medium', 'high'], autoMapping: { Router: 'r', LOW: 'low', MEDIUM: 'medium', HIGH: 'high' }, control: { modelId: 'high' }, premiumModels: ['high'] };
  const exports = {};
  const runs = ['auto', 'manual'].map(mode => {
    const sessionId = mode, turn_id = `${mode}-turn`;
    const models = (mode === 'auto' ? [['router', 'r'], ['worker', 'low']] : [['worker', 'high']]).map(([role, model], index) => ({ session_id: sessionId, turn_id, request_id: `${mode}-${index}`, provider: 'openai', role, model, route: 'LOW', duration_ms: 5, success: true }));
    exports[mode] = { sessions: [{ session_id: sessionId }], turns: [{ session_id: sessionId, turn_id, provider_id: 'openai', provider_segment_id: 'segment', routing_mode: mode, initial_route: 'LOW', final_route: 'LOW', router_request_count: mode === 'auto' ? 1 : 0, worker_model_requests: 1, retry_count: 0, escalation_count: 0, duration_ms: mode === 'auto' ? 10 : 20, status: 'completed' }], modelRequests: models, toolEvents: [] };
    return { caseId: 'mechanical', pairId: 'pair-1', mode, sessionId, accepted: true, acceptanceEvidence: 'synthetic assertions only', telemetry: [mode], configuration: structuredClone(configuration) };
  });
  return { manifest: { schemaVersion: 1, evidenceKind: 'synthetic-tooling-only', runs }, exports };
}
const run = f => report(f.manifest, name => f.exports[name]);
test('synthetic aggregates are factual, Router included, unknown tokens/cost not fabricated', () => {
  const f = fixture(), result = run(f);
  assert.equal(result.realBenchmarkResults, 'PENDING');
  assert.equal(result.allRuns.auto.modelRequests, 2); assert.equal(result.allRuns.manual.highTierRequests, 1);
  assert.equal(result.runs[0].tokens.input.observedTotal, null);
  assert.equal(result.pairs[0].quality, 'Correct + mixed resources');
  assert.equal(result.pairs[0].deltaAutoMinusManual.durationMs, -10);
  assert.ok(!JSON.stringify(result).includes('estimated_api_equivalent_cost'));
  assert.match(markdown(result), /synthetic-tooling-only/);
  assert.deepEqual(run(f), result, 'deterministic');
});
test('quality gate excludes failed or incomplete pairs from accepted comparison', () => {
  const f = fixture(); f.manifest.runs[0].accepted = false; f.exports.auto.turns[0].status = 'failed';
  const result = run(f); assert.equal(result.pairs[0].quality, 'Failed / incomplete');
  assert.equal(result.bothAcceptedPairs.manual.runs, 0); assert.equal(result.allRuns.manual.accepted, 1);
  f.manifest.runs[0].accepted = true; assert.throws(() => run(f), /quality gate/);
});
test('zero-request failed preflight is retained as a failed job rather than a savings win', () => {
  const f = fixture(); f.manifest.runs[0].accepted = false; f.exports.auto.modelRequests = [];
  Object.assign(f.exports.auto.turns[0], { status:'failed', router_request_count:0, worker_model_requests:0 });
  const result = run(f); assert.equal(result.runs[0].modelRequests, 0); assert.equal(result.pairs[0].quality, 'Failed / incomplete');
  assert.equal(result.bothAcceptedPairs.auto.runs, 0);
});
test('same, fewer and more resource outcomes permit disproof', () => {
  const f = fixture(); f.exports.auto.modelRequests.pop(); f.exports.auto.modelRequests[0] = { ...f.exports.manual.modelRequests[0], role: 'worker', model: 'low', session_id: 'auto', turn_id: 'auto-turn', request_id: 'a' };
  f.exports.auto.turns[0].router_request_count = 0;
  assert.equal(run(f).pairs[0].quality, 'Correct + fewer resources');
  f.exports.auto.modelRequests[0].model = 'high'; f.exports.auto.modelRequests[0].route = 'HIGH';
  assert.equal(run(f).pairs[0].quality, 'Correct + same resources');
  f.exports.auto.modelRequests.push({ ...f.exports.auto.modelRequests[0], request_id: 'extra' }); f.exports.auto.turns[0].worker_model_requests = 2;
  assert.equal(run(f).pairs[0].quality, 'Correct + more resources');
});
test('observed token coverage never implies provider exact usage', () => {
  const f = fixture(); f.exports.auto.modelRequests[0].observed_input_tokens = 0;
  let tokens = run(f).runs[0].tokens.input;
  assert.equal(tokens.observedTotal, null); assert.equal(tokens.observedKnownSubtotal, 0); assert.equal(tokens.unavailableRequests, 1);
  f.exports.auto.modelRequests[1].observed_input_tokens = 4;
  assert.equal(run(f).runs[0].tokens.input.observedTotal, 4);
});
test('invalid control, baseline, mode, provider, model, orphan or duplicate evidence fails closed', () => {
  for (const mutate of [
    f => f.manifest.runs[1].configuration.control.modelId = 'missing',
    f => f.manifest.runs[1].configuration.baseline.workspaceSha256 = 'dirty-other',
    f => f.exports.manual.modelRequests[0].role = 'router',
    f => f.exports.manual.modelRequests[0].provider = 'other',
    f => f.exports.manual.modelRequests[0].model = 'medium',
    f => f.exports.auto.modelRequests[0].turn_id = 'orphan',
    f => f.exports.auto.modelRequests.push(f.exports.auto.modelRequests[0]),
    f => f.exports.auto.turns.push(f.exports.auto.turns[0]),
    f => f.exports.auto.toolEvents.push({ session_id: 'auto', turn_id: 'orphan' }),
    f => f.exports.auto.modelRequests[0].observed_input_tokens = -1,
    f => f.exports.auto.turns[0].duration_ms = NaN,
    f => f.manifest.runs.pop(),
    f => f.manifest.runs[1].sessionId = 'auto',
    f => f.exports.auto.sessions.push({ session_id: 'other' }),
    f => f.exports.auto.turns[0].router_request_count = 2,
    f => f.manifest.runs[0].acceptanceEvidence = '',
    f => f.manifest.runs[0].configuration.premiumModels = undefined
  ]) { const f = fixture(); mutate(f); assert.throws(() => run(f)); }
});
if (require.main === module && process.env.NX_BENCHMARK_SYNTHETIC_OUTPUT) {
  const fs = require('node:fs'), path = require('node:path'), f = fixture();
  const destination = process.env.NX_BENCHMARK_SYNTHETIC_OUTPUT; fs.mkdirSync(destination, { recursive: true });
  const result = run(f); fs.writeFileSync(path.join(destination, 'synthetic-report.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(destination, 'synthetic-report.md'), markdown(result));
}
