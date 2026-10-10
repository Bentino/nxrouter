// Two actual production-contribution hosts, same disposable profile/workspace. Fake provider only in a temporary probe.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-ui05-restart-'));
const profile = path.join(temp, 'profile'), workspace = path.join(temp, 'workspace'), probe = path.join(temp, 'probe'), development = path.join(temp, 'development');
for (const dir of [path.join(profile, 'User'), workspace, probe, development]) fs.mkdirSync(dir, { recursive: true });
const requestsFile = path.join(temp, 'requests.json');
const referenceFile = path.join(temp, 'references.json');
fs.writeFileSync(path.join(workspace, 'README.md'), 'UI06_RESTART_REFERENCE_DATA: harmless explicitly attached workspace context.');
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false }));
fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'nx-history-restart-probe', publisher: 'local-test', version: '0.0.1',
  engines: { vscode: '^1.140.0' }, main: './index.js', activationEvents: ['*'] }));
fs.writeFileSync(path.join(probe, 'index.js'), `
exports.install = async () => {
  const vscode = require('vscode'), fs = require('node:fs');
  if (fs.existsSync(${JSON.stringify(path.join(workspace, 'README.md'))})) await vscode.window.showTextDocument(vscode.Uri.file(${JSON.stringify(path.join(workspace, 'README.md'))}));
  const { OpenAIProvider } = require(${JSON.stringify(path.join(root, 'out/runtime/openaiProvider.js'))});
  const { NxProviderManager } = require(${JSON.stringify(path.join(root, 'out/runtime/providers.js'))});
  const { BoundaryFixtureProvider } = require(${JSON.stringify(path.join(root, 'out/test/providerFixture.js'))});
  const second = new BoundaryFixtureProvider();
  const originalAll = NxProviderManager.prototype.all;
  NxProviderManager.prototype.all = function() { return [...originalAll.call(this), second]; };
  const originalResolve = second.resolveModel.bind(second);
  second.resolveModel = async selection => {
    const resolved = await originalResolve(selection); if (!resolved) return;
    const send = resolved.sendRequest.bind(resolved);
    resolved.sendRequest = async (messages, options, token) => {
      fs.writeFileSync(${JSON.stringify(requestsFile)}, String(++requests));
      fs.writeFileSync(${JSON.stringify(referenceFile)}, JSON.stringify({ provider: second.id, hasATranscript: JSON.stringify(messages).includes('อธิบาย NX Router แบบสั้น ๆ'), hasReference: JSON.stringify(messages).includes('UI06_RESTART_REFERENCE_DATA') }));
      return send(messages, options, token);
    }; return resolved;
  };
  const { validateAutoMapping } = require(${JSON.stringify(path.join(root, 'out/runtime/autoConfiguration.js'))});
  const model = 'local-history-test', profile = { providerId: 'openai', auto: { router: { modelId: model }, tiers: {
    LOW: { modelId: model }, MEDIUM: { modelId: model }, HIGH: { modelId: model } } } };
  const models = [{ id: model, name: 'Captured local test model', availability: 'available', effortOptions: [] }];
  let requests = 0; fs.writeFileSync(${JSON.stringify(requestsFile)}, '0');
  OpenAIProvider.prototype.connectionStatus = async () => 'connected';
  OpenAIProvider.prototype.profile = () => profile;
  OpenAIProvider.prototype.listModels = async () => models;
  OpenAIProvider.prototype.configuration = OpenAIProvider.prototype.refreshConfiguration = async () => {
    const auto = validateAutoMapping(profile, [model], true);
    return { state: 'connected', providerId: 'openai', auto, models, mappings: Object.fromEntries(Object.entries(auto.mappings).map(([role, mapping]) =>
      [role, { modelId: mapping.modelId, validity: mapping.validity, available: mapping.valid, effort: 'provider default' }])) };
  };
  OpenAIProvider.prototype.resolveModel = async () => ({ id: model, vendor: 'openai', countTokens: async () => 1,
    sendRequest: async (messages, options) => {
      fs.writeFileSync(${JSON.stringify(requestsFile)}, String(++requests));
      fs.writeFileSync(${JSON.stringify(referenceFile)}, JSON.stringify({ hasReference: JSON.stringify(messages).includes('UI06_RESTART_REFERENCE_DATA') }));
      const router = options?.modelOptions?.temperature === 0 || !options?.tools;
      const text = router ? JSON.stringify({ route: 'MEDIUM', confidence: 0.95, reason: 'Local test', normalized_task: 'Local restart continuity',
        intent: 'investigate', scope: 'single_file', needs_more_context: false, missing_context: [], risk_flags: [] }) : '## Saved answer\\nคำตอบจาก isolated provider';
      return { text: (async function* () { yield text; })(), stream: (async function* () { yield new vscode.LanguageModelTextPart(text); })() };
    } });

};`);
// Bootstrap the fixture before production activation, including before startup history restore.
// Contributions remain byte-for-byte production; no fixture model/tool/setting is contributed.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
assert.equal(manifest.contributes.languageModelChatProviders, undefined);
manifest.main = './bootstrap.js';
fs.writeFileSync(path.join(development, 'package.json'), JSON.stringify(manifest));
fs.symlinkSync(path.join(root, 'out'), path.join(development, 'out'), 'dir');
fs.symlinkSync(path.join(root, 'media'), path.join(development, 'media'), 'dir');
fs.writeFileSync(path.join(development, 'bootstrap.js'), `const implementation = require(${JSON.stringify(path.join(root,'out/extension.js'))}); exports.activate = async context => { await require(${JSON.stringify(path.join(probe,'index.js'))}).install(); return implementation.activate(context); }; exports.deactivate = implementation.deactivate;`);
const port = Number(process.env.NX_HISTORY_RESTART_PORT || (15000 + Math.floor(Math.random() * 20000)));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NX_ROUTER_FIXTURES;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser;
async function launch() {
  const log = fs.openSync(path.join(temp, `host-${Date.now()}.log`), 'w');
  child = spawn(process.env.VSCODE_EXECUTABLE || '/usr/share/code/code', [workspace, `--extensionDevelopmentPath=${development}`,
    `--user-data-dir=${profile}`, `--extensions-dir=${temp}/extensions`, `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes'], { env, detached: true, stdio: ['ignore', log, log] });
  for (let i = 0; i < 60; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await delay(500); } }
  assert.ok(browser); const page = browser.contexts()[0].pages()[0];
  await page.getByRole('tab', { name: /^NX Router/ }).click({ timeout: 30000 });
  for (let i = 0; i < 60; i++) {
    for (const frame of page.frames()) { try { if (await frame.getByRole('button', { name: 'View all', exact: true }).count()) return { page, sidebar: frame }; } catch { /* Webview frame replaced during startup. */ } }
    await delay(250);
  }
  throw new Error('History Sidebar not loaded');
}
async function close() {
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) { const session = await page.context().newCDPSession(page).catch(() => undefined); await session?.send('Browser.close').catch(() => {}); }
    await browser.close().catch(() => {}); browser = undefined;
  }
  if (child) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Group already exited. */ }
    if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No disposable processes remain. */ }
  }
  child = undefined; await delay(800);
}
(async () => {
  try {
    let { page, sidebar } = await launch();
    await sidebar.getByRole('button', { name: 'New Chat', exact: true }).waitFor({ timeout: 15000 });
    for (let i = 0; i < 50 && await sidebar.getByRole('button', { name: 'New Chat', exact: true }).isDisabled(); i++) await delay(200);
    await sidebar.getByRole('button', { name: 'New Chat', exact: true }).click();
    await page.getByText('New Chat provider', { exact: true }).waitFor(); await page.locator('.quick-input-widget input').fill('OpenAI'); await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'OpenAI / ChatGPT' }).waitFor(); await page.keyboard.press('Enter');
    await sidebar.getByRole('switch', { name: 'Auto', exact: true }).uncheck();
    await sidebar.getByRole('combobox', { name: 'Model', exact: true }).selectOption('local-history-test');
    // Native QuickPick keyboard flow, host current-file resolution, and keyboard Remove.
    await sidebar.waitForFunction(() => document.querySelector('[aria-label="Add Context"]')?.disabled === false);
    await sidebar.getByRole('button', { name: 'Add Context', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByText('Add Context', { exact: true }).waitFor(); await page.locator('.quick-input-widget input').fill('Current file'); await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'Current file' }).waitFor(); await page.keyboard.press('Enter');
    await sidebar.getByRole('button', { name: 'Remove README.md', exact: true }).waitFor();
    await sidebar.waitForFunction(() => document.querySelector('[aria-label="Remove README.md"]')?.disabled === false);
    await sidebar.getByRole('button', { name: 'Remove README.md', exact: true }).focus(); await page.keyboard.press('Enter');
    await sidebar.getByRole('button', { name: 'Remove README.md', exact: true }).waitFor({ state: 'hidden' });
    await sidebar.waitForFunction(() => document.querySelector('[aria-label="Add Context"]')?.disabled === false);
    await sidebar.getByRole('button', { name: 'Add Context', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.getByText('Add Context', { exact: true }).waitFor(); await page.locator('.quick-input-widget input').fill('Current file'); await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'Current file' }).waitFor(); await page.keyboard.press('Enter');
    await sidebar.getByRole('button', { name: 'Remove README.md', exact: true }).waitFor();
    const prompt = 'อธิบาย NX Router แบบสั้น ๆ';
    await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).fill(prompt);
    await sidebar.getByRole('button', { name: 'Send', exact: true }).click();
    await sidebar.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    await sidebar.locator('.message.assistant .message-text').filter({ hasText: 'Saved answer' }).waitFor({ timeout: 15000 });
    await sidebar.locator('.message.assistant').filter({ hasText: /Completed.*Captured local test model/s }).waitFor();
    await sidebar.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    assert.match(await sidebar.locator('.message.assistant').innerText(), /Completed.*Captured local test model/s);
    assert.equal(JSON.parse(fs.readFileSync(referenceFile)).hasReference, true);
    assert.equal(await sidebar.locator('.context-chips button').count(), 0);
    assert.equal(await sidebar.locator('.historical-context').first().innerText(), 'README.md');
    assert.equal(await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).inputValue(), '');
    // Explicit native provider picker and Continue fresh keyboard confirmation.
    await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).fill('B fresh turn');
    await sidebar.getByRole('button', { name: 'Switch provider', exact: true }).focus(); await page.keyboard.press('Enter');
    await page.locator('.quick-input-widget').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(root, '.test-results', 'ui07-provider-picker.png') });
    await page.locator('.quick-input-widget input').fill('boundary-fixture'); await page.keyboard.press('Enter');
    await page.getByText('Switch provider: OpenAI / ChatGPT → Local boundary-fixture', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(root, '.test-results', 'ui07-fresh-confirmation.png') });
    assert.match(await page.locator('.quick-input-widget').innerText(), /Continue fresh.*Carry selected context.*Start new chat/s);
    await page.keyboard.press('Enter');
    await sidebar.locator('.provider-boundary').waitFor();
    assert.equal(await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).inputValue(), 'B fresh turn', 'Provider switch preserves draft text');
    await sidebar.getByRole('button', { name: 'Send', exact: true }).click();
    await sidebar.locator('.message.assistant').nth(1).filter({ hasText: 'Answer from boundary-fixture' }).waitFor({ timeout: 15000 });
    await sidebar.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    assert.equal(JSON.parse(fs.readFileSync(referenceFile)).hasATranscript, false);
    assert.equal(JSON.parse(fs.readFileSync(referenceFile)).hasReference, false);
    await page.screenshot({ path: path.join(root, '.test-results', 'ui07-boundary.png') });
    // Native selected carry privacy dialog; cancel leaves the active provider unchanged.
    await sidebar.getByRole('button', { name: 'Switch provider', exact: true }).click();
    await page.getByText('Choose provider', { exact: true }).waitFor(); await page.locator('.quick-input-widget input').fill('OpenAI'); await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'OpenAI / ChatGPT' }).waitFor(); await page.keyboard.press('Enter');
    await page.getByText('Switch provider: Local boundary-fixture → OpenAI / ChatGPT', { exact: true }).waitFor();
    await page.locator('.quick-input-widget input').fill('Carry selected context'); await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: 'Carry selected context' }).waitFor(); await page.keyboard.press('Enter');
    await page.getByText('Carry context to OpenAI / ChatGPT', { exact: true }).waitFor();
    await page.locator('.quick-input-widget .monaco-list-row').first().waitFor();
    const carryCheckbox = page.locator('.quick-input-widget .monaco-checkbox').first();
    await carryCheckbox.focus(); await page.keyboard.press('Space');
    assert.equal(await carryCheckbox.getAttribute('aria-checked'), 'true');
    await page.locator('.quick-input-widget input').focus(); await page.keyboard.press('Enter');
    await page.getByText(/Selected context will be sent to OpenAI \/ ChatGPT:/).waitFor();
    await page.screenshot({ path: path.join(root, '.test-results', 'ui07-carry-confirmation.png') });
    await page.keyboard.press('Escape');
    assert.equal(await sidebar.locator('.provider-boundary').count(), 1);
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click();
    await sidebar.locator('.session-title').filter({ hasText: prompt }).waitFor();
    await close(); fs.unlinkSync(path.join(workspace, 'README.md'));
    ({ page, sidebar } = await launch());
    await sidebar.locator('.session-title').filter({ hasText: prompt }).waitFor({ timeout: 15000 });
    assert.equal(Number(fs.readFileSync(requestsFile)), 0, 'Restart never invokes provider');
    await sidebar.locator('.session-open').filter({ hasText: prompt }).click();
    await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).waitFor();
    assert.match(await sidebar.locator('.message.assistant .message-text').first().innerText(), /Saved answer.*คำตอบ/s);
    assert.match(await sidebar.locator('.message.assistant').first().innerText(), /Captured local test model/);
    assert.equal(Number(fs.readFileSync(requestsFile)), 0, 'Opening never invokes provider');
    assert.equal(await sidebar.locator('.historical-context').first().innerText(), 'README.md', 'History uses descriptors even when file no longer exists');
    assert.equal(await sidebar.locator('.historical-context button').count(), 0);
    await sidebar.getByRole('button', { name: 'Home', exact: true }).click(); await sidebar.getByRole('button', { name: 'View all', exact: true }).click();
    const search = sidebar.getByRole('searchbox', { name: 'Search chats', exact: true }); await search.fill('อธิบาย');
    await delay(500); assert.equal(await sidebar.locator('.session-open').count(), 1); assert.equal(Number(fs.readFileSync(requestsFile)), 0);
    await search.press('Tab'); await sidebar.locator('.session-open').press('Enter');
    await page.screenshot({ path: path.join(root, '.test-results', 'ui07-restored.png') });
    await sidebar.getByRole('switch', { name: 'Auto', exact: true }).waitFor();
    assert.equal(await sidebar.getByRole('switch', { name: 'Auto', exact: true }).isChecked(), true, 'B Auto validates and restores with its fixture registered before activation');
    await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).fill('continue');
    await sidebar.getByRole('button', { name: 'Send', exact: true }).click();
    await sidebar.locator('.message.assistant').nth(2).waitFor();
    await sidebar.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    assert.ok(Number(fs.readFileSync(requestsFile)) > 0, 'New turn uses runtime');
    assert.equal(JSON.parse(fs.readFileSync(referenceFile)).hasReference, false, 'Old context is never resent');
    assert.equal(JSON.parse(fs.readFileSync(referenceFile)).provider, 'boundary-fixture');
    assert.equal(JSON.parse(fs.readFileSync(referenceFile)).hasATranscript, false);
    assert.equal(await sidebar.locator('.provider-boundary').count(), 1);
    fs.writeFileSync(path.join(root, '.test-results', 'ui07-restart.json'), JSON.stringify({ status: 'passed', actualExtensionHostRestart: true, productionContributions: true, authenticated: false, checks: ['native multi-provider picker and fresh default by keyboard', 'draft text preserved across switch', 'A then B shared runtime turns', 'B receives no A transcript or references', 'native carry destination consent and cancel', 'segments/boundary/captured identity survive two hosts', 'zero requests on restart/open/search', 'new turn still uses B without A transcript'] }, null, 2));
    fs.writeFileSync(path.join(root, '.test-results', 'ui06-restart.json'), JSON.stringify({ status: 'passed', actualExtensionHostRestart: true, authenticated: false,
      checks: ['native Add Context QuickPick by keyboard', 'Current file host resolution', 'keyboard Remove and reattach', 'sent chip clears', 'descriptor survives restart with deleted source', 'zero requests on restart/open/search', 'new turn does not resend context'] }, null, 2));
    fs.mkdirSync(path.join(root, '.test-results'), { recursive: true });
    fs.writeFileSync(path.join(root, '.test-results', 'ui05-restart.json'), JSON.stringify({ status: 'passed', actualExtensionHostRestart: true,
      productionContributions: true, authenticated: false, checks: ['same disposable profile/workspace', 'first turn via shipped Webview/bridge/shared NxRuntime', 'title/transcript/captured model survive restart', 'no requests on restart/open/search', 'keyboard search/open', 'new turn through shared NxRuntime'] }, null, 2));
    console.log('UI-05 production-contribution two-host restart passed (temporary fake provider; no authenticated evidence).');
  } finally { await close(); }
})().catch(error => { console.error(error); console.error('Disposable logs:', temp); process.exitCode = 1; });
