// Production contributions, real native approvals/diff; disposable workspace, no provider/account.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.test-results'), { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-router-native-review-'));
const profile = path.join(temp, 'profile'), workspace = path.join(temp, 'workspace'), result = path.join(temp, 'result.json');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true }); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom',
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false
}));
const probe = path.join(temp, 'review-probe'); fs.mkdirSync(probe);
fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'nx-review-probe', publisher: 'local-test', version: '0.0.1',
  engines: { vscode: '^1.140.0' }, main: './index.js', activationEvents: ['onStartupFinished'] }));
fs.writeFileSync(path.join(probe, 'index.js'), `exports.activate = () => { require(${JSON.stringify(path.join(root, 'out/test/sidebarNativeReview.js'))}).run().catch(error => require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify({status:'failed', error:String(error)}))); };`);
const port = Number(process.env.NX_NATIVE_REVIEW_PORT || 9349);
const env = { ...process.env, NX_NATIVE_REVIEW_RESULTS: result }; delete env.ELECTRON_RUN_AS_NODE; delete env.NX_ROUTER_FIXTURES;
const logPath = path.join(temp, 'host.log');
const log = fs.openSync(logPath, 'w');
const child = spawn(process.env.VSCODE_EXECUTABLE || '/usr/share/code/code', [workspace, `--extensionDevelopmentPath=${root}`,
  `--extensionDevelopmentPath=${probe}`, `--user-data-dir=${profile}`, `--extensions-dir=${temp}/extensions`,
  `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes'], { env, stdio: ['ignore', log, log] });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await delay(500); }
    }
    assert.ok(browser, 'VS Code debugging endpoint did not start');
    const page = browser.contexts()[0].pages()[0];
    const confirm = page.getByRole('button', { name: /^(Allow|Yes)$/ });
    await confirm.waitFor({ timeout: 30000 });
    await confirm.click();
    await page.getByRole('button', { name: /^Apply$/ }).waitFor({ timeout: 15000 });
    await page.screenshot({ path: path.join(root, '.test-results', 'ui03-native-diff.png') });
    await page.getByRole('button', { name: /^Apply$/ }).click();
    await confirm.waitFor({ timeout: 15000 }); await confirm.click();
    await page.getByRole('button', { name: /^Cancel$/ }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    // Edit Apply, Copy, Move, allowed verification, then denied dangerous command.
    await confirm.waitFor({ timeout: 15000 }); await confirm.click();
    await page.getByRole('button', { name: /^Apply$/ }).waitFor({ timeout: 15000 }); await page.getByRole('button', { name: /^Apply$/ }).click();
    for (const operation of ['copy', 'move']) {
      await confirm.waitFor({ timeout: 15000 }); await confirm.click();
      await page.getByRole('button', { name: /^Apply$/ }).waitFor({ timeout: 15000 }); await page.getByRole('button', { name: /^Apply$/ }).click();
    }
    for (const operation of ['verification', 'denied']) { await confirm.waitFor({ timeout: 15000 }); await confirm.click(); }
    for (let attempt = 0; attempt < 60 && !fs.existsSync(result); attempt++) await delay(250);
    assert.ok(fs.existsSync(result), 'Native tool review test did not finish');
    const evidence = JSON.parse(fs.readFileSync(result)); assert.equal(evidence.status, 'passed');
    fs.writeFileSync(path.join(root, '.test-results', 'ui03-native-review.json'), JSON.stringify(evidence, null, 2));
    console.log('Production native review smoke passed:', evidence.checks.join('; '));
  } catch (error) {
    console.error(fs.readFileSync(logPath, 'utf8').slice(-5000));
    if (browser) { const page = browser.contexts()[0].pages()[0]; if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-6000)); } }
    throw error;
  } finally { if (browser) await browser.close(); child.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
