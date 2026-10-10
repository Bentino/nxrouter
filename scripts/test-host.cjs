const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-router-host-'));
const workspace = path.join(temp, 'workspace');
const userData = path.join(temp, 'profile');
const developmentExtension = path.join(temp, 'nx-router-fixtures');
fs.mkdirSync(developmentExtension);
const developmentManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const fixtureContributions = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'fixture-contributions.json'), 'utf8'));
developmentManifest.contributes.commands.push(...fixtureContributions.commands);
developmentManifest.contributes.languageModelChatProviders = fixtureContributions.languageModelChatProviders;
developmentManifest.contributes.languageModelTools.push(...fixtureContributions.languageModelTools);
Object.assign(developmentManifest.contributes.configuration.properties, fixtureContributions.configuration.properties);
fs.writeFileSync(path.join(developmentExtension, 'package.json'), JSON.stringify(developmentManifest));
fs.symlinkSync(path.join(root, 'out'), path.join(developmentExtension, 'out'), 'dir');
fs.symlinkSync(path.join(root, 'media'), path.join(developmentExtension, 'media'), 'dir');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'window.dialogStyle': 'custom',
  'update.mode': 'none', 'extensions.autoUpdate': false
}));
fs.cpSync(path.join(root, '.github'), path.join(workspace, '.github'), { recursive: true });
const ui = process.argv.includes('--ui');
const args = [workspace, `--extensionDevelopmentPath=${developmentExtension}`, '--no-sandbox',
  '--disable-gpu', `--user-data-dir=${userData}`, `--extensions-dir=${temp}/extensions`, '--skip-welcome', '--skip-release-notes'];
if (ui) { args.push(`--remote-debugging-port=${process.env.NX_SPIKE_DEBUG_PORT || '9333'}`); }
else { args.push(`--extensionTestsPath=${root}/out/test/suite.js`); }
const env = { ...process.env, NX_SPIKE_RESULTS: path.join(root, '.test-results', 'native-api.json') };
env.NX_ROUTER_FIXTURES = '1';
delete env.ELECTRON_RUN_AS_NODE;
console.log(`Isolated Extension Development Host workspace: ${workspace}`);
const child = spawn(process.env.VSCODE_EXECUTABLE || '/usr/share/code/code', args, { env, stdio: 'inherit' });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, ui ? 30 * 60 * 1000 : 120000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
