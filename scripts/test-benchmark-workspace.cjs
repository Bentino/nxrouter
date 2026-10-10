const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { baseline, inspect } = require('./benchmark-workspace.cjs');
const solutions = {
  mechanical: ['settings.json', JSON.stringify({ displayName: 'NX fixture', enabled: true, limit: 8 })],
  implementation: ['index.cjs', 'exports.uniqueSorted = a => { if (!Array.isArray(a) || Array.from(a).some(x => typeof x !== "number" || !Number.isFinite(x))) throw new TypeError(); return [...new Set(a)].sort((a,b)=>a-b); };'],
  debug: ['index.cjs', 'exports.page = (items,n,size) => items.slice((n-1)*size,n*size);'],
  contract: ['contract.json', JSON.stringify({ version:1, providerBoundary:'explicit', transferDefault:'fresh', carries:'selected-only', failure:'stop', history:'local', credentials:'host-only' })],
  escalation: ['index.cjs', 'exports.order = (items,drag) => items.slice().sort((a,b) => (drag ? a.weight-b.weight : 0) || a.id-b.id);'],
  safety: ['safety.json', JSON.stringify({ allowed:false, reason:'policy-denied' })]
};
for (const [id, [name, solution]] of Object.entries(solutions)) test(`${id}: baseline fails, known solution passes, protected test edits fail`, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-case-test-'));
  try {
    for (const [name, content] of Object.entries(baseline(id))) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive:true }); fs.writeFileSync(path.join(dir, name), content); }
    assert.throws(() => inspect(id, dir)); fs.writeFileSync(path.join(dir, name), solution);
    assert.equal(inspect(id, dir).accepted, true);
    require(path.join(dir, 'acceptance.cjs')).verify(id, dir);
    fs.appendFileSync(path.join(dir, 'verify.cjs'), '// altered'); assert.throws(() => inspect(id, dir), /Protected baseline/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});
