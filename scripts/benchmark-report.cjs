// Offline only. Case/pair identities never enter NxRuntime or production telemetry.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const same = (a, b, message) => assert.deepEqual(a, b, message);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const number = value => Number.isFinite(value) && value >= 0;
const total = (rows, key) => rows.reduce((sum, row) => sum + (row[key] ?? 0), 0);
function report(manifest, readExport) {
  same(manifest.schemaVersion, 1, 'Unsupported benchmark manifest');
  assert.ok(['synthetic-tooling-only', 'authenticated-local'].includes(manifest.evidenceKind), 'Explicit evidence kind required');
  assert.ok(Array.isArray(manifest.runs) && manifest.runs.length, 'Runs required');
  const identities = new Set(), sessions = new Set();
  const runs = manifest.runs.map(run => {
    for (const key of ['caseId', 'pairId', 'sessionId', 'acceptanceEvidence']) assert.ok(nonempty(run[key]), `${key} required`);
    assert.ok(['auto', 'manual'].includes(run.mode));
    assert.equal(typeof run.accepted, 'boolean');
    const key = `${run.pairId}:${run.mode}`;
    assert.ok(!identities.has(key), 'Duplicate pair/mode'); identities.add(key);
    assert.ok(!sessions.has(run.sessionId), 'A session cannot represent two benchmark runs'); sessions.add(run.sessionId);
    const config = run.configuration;
    assert.ok(config && nonempty(config.providerId), 'Provider required');
    for (const section of ['baseline', 'environment', 'extension']) assert.ok(config[section] && Object.keys(config[section]).length, `${section} required`);
    for (const field of ['commit', 'fixtureSha256', 'workspaceSha256']) assert.ok(nonempty(config.baseline[field]), `Baseline ${field} required`);
    for (const field of ['node', 'vscode', 'platform']) assert.ok(nonempty(config.environment[field]), `Environment ${field} required`);
    for (const field of ['version', 'sha256']) assert.ok(nonempty(config.extension[field]), `Extension ${field} required`);
    assert.ok(Array.isArray(config.catalog) && config.catalog.length && config.catalog.every(nonempty), 'Actual catalog required');
    for (const role of ['Router', 'LOW', 'MEDIUM', 'HIGH']) assert.ok(config.catalog.includes(config.autoMapping?.[role]), `Unavailable ${role} mapping`);
    assert.ok(config.catalog.includes(config.control?.modelId), 'Unavailable explicit control; substitution forbidden');
    assert.ok(Array.isArray(config.premiumModels) && config.premiumModels.every(id => config.catalog.includes(id)), 'Explicit premium classification required');
    assert.ok(Array.isArray(run.telemetry) && run.telemetry.length, 'Telemetry export files required');
    const data = { sessions: [], turns: [], modelRequests: [], toolEvents: [] };
    for (const file of run.telemetry) {
      assert.ok(nonempty(file)); const exported = readExport(file);
      assert.ok(exported.schemaVersion === undefined || exported.schemaVersion === 1, 'Unsupported telemetry schema');
      for (const name of Object.keys(data)) {
        assert.ok(Array.isArray(exported[name]), `Missing ${name}`);
        assert.ok(exported[name].every(row => row.session_id === run.sessionId), 'Export must contain only the explicitly mapped session');
        data[name].push(...exported[name]);
      }
    }
    assert.ok(data.sessions.length === 1 && data.turns.length, 'Incomplete/duplicated export');
    const turnIds = new Set();
    for (const turn of data.turns) {
      assert.ok(nonempty(turn.turn_id) && !turnIds.has(turn.turn_id), 'Duplicate/missing turn'); turnIds.add(turn.turn_id);
      same(turn.provider_id, config.providerId, 'Provider mismatch'); same(turn.routing_mode, run.mode, 'Mode mismatch');
      assert.ok(nonempty(turn.provider_segment_id), 'Provider segment required');
      assert.ok(['completed', 'partial', 'failed', 'cancelled'].includes(turn.status), 'Invalid terminal outcome');
      for (const field of ['initial_route', 'final_route']) assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(turn[field]), `Invalid ${field}`);
      for (const field of ['duration_ms', 'retry_count']) assert.ok(number(turn[field]), `Missing/invalid ${field}`);
      for (const field of ['escalation_count', 'router_request_count']) if (turn[field] !== undefined) assert.ok(number(turn[field]));
      if (run.accepted) assert.ok(['completed', 'partial'].includes(turn.status), 'Failed/cancelled run cannot pass quality gate');
    }
    if (run.accepted) assert.ok(data.modelRequests.some(model => model.role === 'worker' && model.success), 'Accepted benchmark requires observed worker execution');
    const requests = new Set();
    for (const model of data.modelRequests) {
      assert.ok(turnIds.has(model.turn_id), 'Orphan model request');
      assert.ok(nonempty(model.request_id) && !requests.has(model.request_id), 'Duplicate/missing request'); requests.add(model.request_id);
      same(model.provider, config.providerId, 'Model provider mismatch');
      assert.ok(['router', 'worker'].includes(model.role) && number(model.duration_ms) && typeof model.success === 'boolean');
      assert.ok(config.catalog.includes(model.model), 'Requested model absent from captured catalog');
      for (const field of ['observed_input_tokens', 'observed_output_tokens']) if (model[field] !== undefined) assert.ok(number(model[field]), 'Invalid observed token count');
      if (run.mode === 'manual') {
        same(model.role, 'worker', 'Manual must issue zero Router requests');
        same(model.model, config.control.modelId, 'Manual control changed');
        same(model.effort, config.control.effort, 'Manual effort changed');
      } else {
        const role = model.role === 'router' ? 'Router' : model.route;
        assert.ok(['Router', 'LOW', 'MEDIUM', 'HIGH'].includes(role));
        same(model.model, config.autoMapping[role], 'Auto mapping changed');
      }
    }
    for (const turn of data.turns) {
      const models = data.modelRequests.filter(model => model.turn_id === turn.turn_id);
      if (turn.router_request_count !== undefined) same(turn.router_request_count, models.filter(model => model.role === 'router').length, 'Router accounting mismatch');
      if (run.mode === 'manual') same(turn.router_request_count, 0, 'Manual Router count must be explicit zero');
      if (turn.worker_model_requests !== undefined) same(turn.worker_model_requests, models.filter(model => model.role === 'worker').length, 'Worker accounting mismatch');
    }
    for (const tool of data.toolEvents) {
      assert.ok(turnIds.has(tool.turn_id) && nonempty(tool.tool) && number(tool.duration_ms), 'Invalid/orphan tool event');
      assert.ok(['success', 'failed', 'rejected', 'cancelled', 'invalid'].includes(tool.outcome));
    }
    const tokens = field => {
      const known = data.modelRequests.filter(model => model[field] !== undefined);
      return { observedTotal: known.length === data.modelRequests.length ? total(known, field) : null,
        observedKnownSubtotal: known.length ? total(known, field) : null, unavailableRequests: data.modelRequests.length - known.length };
    };
    return { caseId: run.caseId, pairId: run.pairId, mode: run.mode, accepted: run.accepted, acceptanceEvidence: run.acceptanceEvidence,
      configuration: config, sessionId: run.sessionId, actualModels: [...new Set(data.modelRequests.map(model => model.model))].sort(),
      initialRoutes: data.turns.map(turn => turn.initial_route), finalRoutes: data.turns.map(turn => turn.final_route), outcomes: data.turns.map(turn => turn.status),
      modelRequests: data.modelRequests.length, routerRequests: data.modelRequests.filter(model => model.role === 'router').length,
      highTierRequests: data.modelRequests.filter(model => config.premiumModels.includes(model.model)).length,
      escalations: data.turns.every(turn => turn.escalation_count !== undefined) ? total(data.turns, 'escalation_count') : null,
      retries: total(data.turns, 'retry_count'), repairs: null, tools: data.toolEvents.length,
      verificationCalls: data.toolEvents.filter(tool => tool.tool === 'nx_execute').length,
      successfulVerificationCalls: data.toolEvents.filter(tool => tool.tool === 'nx_execute' && tool.outcome === 'success').length,
      deniedOperations: data.toolEvents.filter(tool => tool.outcome === 'rejected').length,
      durationMs: total(data.turns, 'duration_ms'), tokens: { measurement: 'observed_model_count_tokens_not_provider_reported_usage', input: tokens('observed_input_tokens'), output: tokens('observed_output_tokens') } };
  });
  const pairs = [...new Set(runs.map(run => run.pairId))].map(pairId => {
    const auto = runs.find(run => run.pairId === pairId && run.mode === 'auto'), manual = runs.find(run => run.pairId === pairId && run.mode === 'manual');
    assert.ok(auto && manual, 'Every pair requires Auto and Manual'); same(auto.caseId, manual.caseId, 'Case mismatch');
    same(auto.configuration, manual.configuration, 'Baselines/environment/build/catalog/mappings/control must match');
    const delta = Object.fromEntries(['modelRequests', 'highTierRequests', 'durationMs', 'retries', 'tools'].map(key => [key, auto[key] - manual[key]]));
    const resources = [delta.modelRequests, delta.highTierRequests];
    const quality = !auto.accepted || !manual.accepted ? 'Failed / incomplete' : resources.every(n => n === 0) ? 'Correct + same resources' :
      resources.every(n => n <= 0) ? 'Correct + fewer resources' : resources.every(n => n >= 0) ? 'Correct + more resources' : 'Correct + mixed resources';
    return { pairId, caseId: auto.caseId, quality, deltaAutoMinusManual: delta, comparableAccepted: auto.accepted && manual.accepted };
  });
  const aggregate = selected => Object.fromEntries(['auto', 'manual'].map(mode => {
    const rows = selected.filter(run => run.mode === mode);
    return [mode, { accepted: rows.filter(run => run.accepted).length, runs: rows.length,
      ...Object.fromEntries(['modelRequests', 'highTierRequests', 'durationMs', 'retries', 'tools'].map(key => [key, total(rows, key)])) }];
  }));
  return { schemaVersion: 1, evidenceKind: manifest.evidenceKind, realBenchmarkResults: manifest.evidenceKind === 'synthetic-tooling-only' ? 'PENDING' : 'observed local runs; no statistical confidence inferred',
    resourceComparison: 'Pareto comparison of model-request and explicitly classified premium-request counts; duration is separate; no monetary savings claim',
    runs, pairs, allRuns: aggregate(runs), bothAcceptedPairs: aggregate(runs.filter(run => pairs.find(pair => pair.pairId === run.pairId).comparableAccepted)) };
}
function markdown(result) {
  const safe = value => String(value).replace(/[|\r\n]/g, ' ');
  return `# NX local benchmark\n\nEvidence: ${result.evidenceKind}. Real results: ${result.realBenchmarkResults}.\n\n` +
    '| Case | Mode | Accepted | Actual models | Model req | High-tier req | Escalations | Tools | Duration ms |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' +
    result.runs.map(run => `| ${[run.caseId, run.mode, run.accepted, run.actualModels.join(', '), run.modelRequests, run.highTierRequests, run.escalations ?? 'unknown', run.tools, run.durationMs].map(safe).join(' | ')} |`).join('\n') +
    '\n\n' + result.pairs.map(pair => `${safe(pair.pairId)}: ${pair.quality}.`).join('\n\n') +
    '\n\nCounts include Router and failed requests. High-tier classification comes from the external manifest. Token counts, if present, are observed model counts, not exact provider usage. Repairs are unavailable. No cost or savings estimate. See JSON for transparent aggregates and deltas.\n';
}
if (require.main === module) {
  try {
    const [file, json, md] = process.argv.slice(2);
    assert.ok(file && json, 'Usage: node scripts/benchmark-report.cjs manifest.json report.json [report.md]');
    const base = path.dirname(path.resolve(file));
    const result = report(JSON.parse(fs.readFileSync(file, 'utf8')), name => JSON.parse(fs.readFileSync(path.resolve(base, name), 'utf8')));
    fs.writeFileSync(json, JSON.stringify(result, null, 2) + '\n'); if (md) fs.writeFileSync(md, markdown(result));
    console.log(`${result.runs.length} validated runs; ${result.evidenceKind}; no savings claim`);
  } catch (error) { console.error(`Invalid benchmark: ${error.message}`); process.exitCode = 1; }
}
module.exports = { report, markdown };
