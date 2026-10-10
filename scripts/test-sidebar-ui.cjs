// Isolated production-contribution smoke; never uses the user's account or settings.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.test-results'), { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-router-sidebar-ui-'));
const profile = path.join(temp, 'profile');
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(path.join(profile, 'User'), { recursive: true }); fs.mkdirSync(workspace);
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false
}));
const vsix = process.argv.includes('--vsix') ? path.resolve(process.argv[process.argv.indexOf('--vsix') + 1]) : undefined;
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const registryResult = path.join(temp, 'registry.json');
const developmentArgs = [`--extensionDevelopmentPath=${root}`];
if (vsix) {
  execFileSync('python3', [path.join(root, 'scripts/inspect-vsix.py'), vsix], { stdio: 'inherit' });
  execFileSync(process.env.VSCODE_CLI || 'code', ['--install-extension', vsix, '--force', `--user-data-dir=${profile}`, `--extensions-dir=${temp}/extensions`], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const probe = path.join(temp, 'registry-probe'); fs.mkdirSync(probe);
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'nx-registry-probe', publisher: 'local-test', version:'0.0.1', engines:{ vscode:'^1.140.0' }, main:'./index.js', activationEvents:['onStartupFinished'] }));
  fs.writeFileSync(path.join(probe, 'index.js'), `exports.activate = async () => {
    const vscode = require('vscode'), assert = require('node:assert/strict'), fs = require('node:fs');
    try {
      const start = performance.now(), extension = vscode.extensions.getExtension('nx-router.nx-router');
      assert.ok(extension); assert.equal(extension.packageJSON.version, ${JSON.stringify(expectedVersion)}); await extension.activate();
      const commands = await vscode.commands.getCommands(true);
      assert.equal(commands.some(id => /nxRouter\\.(openSpike|acceptanceEvidence|cancellationTask)/.test(id)), false);
      assert.equal(vscode.lm.tools.some(tool => tool.name.startsWith('nx_spike_')), false);
      assert.equal((await vscode.lm.selectChatModels({ vendor:'nx-spike' })).length, 0);
      fs.writeFileSync(${JSON.stringify(registryResult)}, JSON.stringify({ status:'passed', installedArchive:true, installedVersion:extension.packageJSON.version, activationMs:performance.now()-start, fixtureCommands:0, fixtureTools:0, fixtureModels:0 }));
    } catch(error) { fs.writeFileSync(${JSON.stringify(registryResult)}, JSON.stringify({ status:'failed', error:String(error) })); }
  };`);
  developmentArgs.splice(0, 1, `--extensionDevelopmentPath=${probe}`);
}
const started = performance.now();
const port = Number(process.env.NX_SIDEBAR_UI_PORT || 9347);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NX_ROUTER_FIXTURES; if (vsix) env.NX_ROUTER_FIXTURES = '1'; // Manifest gate must still prevent registration.
const child = spawn(process.env.VSCODE_EXECUTABLE || '/usr/share/code/code', [workspace,
  ...developmentArgs, `--user-data-dir=${profile}`, `--extensions-dir=${temp}/extensions`,
  `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes'], { env, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let browser;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await delay(500); }
    }
    assert.ok(browser, 'VS Code debugging endpoint did not start');
    const page = browser.contexts()[0].pages()[0] ?? await browser.contexts()[0].waitForEvent('page', { timeout: 15000 });
    const screenshot = async name => {
      await page.mouse.move(800, 400);
      const ratio = await page.evaluate(() => window.devicePixelRatio);
      if (ratio > 1.1) {
        // Chromium element screenshots clip at native workbench zoom; capture physical viewport instead.
        const session = await page.context().newCDPSession(page);
        const size = await page.evaluate(() => ({ width: window.innerWidth * window.devicePixelRatio, height: window.innerHeight * window.devicePixelRatio }));
        const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, ...size, scale: 1 } });
        fs.writeFileSync(path.join(root, '.test-results', name), Buffer.from(shot.data, 'base64')); await session.detach();
      } else await page.locator('.part.sidebar').screenshot({ path: path.join(root, '.test-results', name), animations: 'disabled' });
    };
    await page.getByRole('tab', { name: /^NX Router/ }).click({ timeout: 30000 });
    let sidebar;
    for (let attempt = 0; attempt < 60; attempt++) {
      for (const frame of page.frames()) {
        if (await frame.getByRole('button', { name: 'Continue with OpenAI / ChatGPT', exact: true }).count()) { sidebar = frame; break; }
      }
      if (sidebar) break;
      await delay(500);
    }
    assert.ok(sidebar, 'First-run Webview did not load');
    const firstRunMs = performance.now() - started;
    if (vsix) {
      for (let i=0; i<60 && !fs.existsSync(registryResult); i++) await delay(250);
      const evidence = JSON.parse(fs.readFileSync(registryResult)); assert.equal(evidence.status, 'passed');
      fs.writeFileSync(path.join(root, '.test-results/ui08-fresh-install.json'), JSON.stringify({ ...evidence, firstRunMs, account:'none', productionFirstRun:true, connectedStates:'injected fixtures only' }, null, 2));
    }
    await sidebar.getByRole('button', { name: 'Continue with OpenAI / ChatGPT', exact: true }).waitFor();
    assert.match(await sidebar.locator('body').innerText(), /Connect an AI provider/);
    assert.equal(await sidebar.locator('#settings svg[aria-hidden="true"]').count(), 1);
    assert.equal(await sidebar.locator('#settings').getAttribute('title'), 'NX Settings');
    assert.equal(await sidebar.locator('#settings').innerText(), '');
    await sidebar.getByRole('button', { name: 'Open NX Router Settings' }).click();
    await page.getByLabel('nxRouter.providers.openai.routerModel', { exact: true }).waitFor({ timeout: 15000 });
    for (const role of ['router', 'low', 'medium', 'high']) {
      assert.equal(await page.getByLabel(`nxRouter.providers.openai.${role}Model`, { exact: true }).inputValue(), '');
    }
    await page.getByLabel('nxRouter.providers.openai.routerModel', { exact: true }).focus();
    await page.keyboard.press('Control+w');
    await page.getByLabel('nxRouter.providers.openai.routerModel', { exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    await sidebar.getByRole('button', { name: 'Continue with OpenAI / ChatGPT', exact: true }).waitFor();
    assert.equal((await sidebar.locator('main').innerText()).match(/Connect OpenAI to start/g)?.length, 1);
    await screenshot('ui04-first-run.png');
    // Exercise the shipped DOM renderer with sanitized fixture projections. No backend mutation.
    const state = { view: 'home', providers: [{ id: 'openai', label: 'OpenAI', connection: 'connected', statusText: 'Connected',
      description: '', actions: ['configureModels', 'status'], autoAvailable: true,
      mappings: ['Router', 'LOW', 'MEDIUM', 'HIGH'].map(role => ({ role, modelId: '<safe-id>', validity: 'available' })) }],
      activeProviderId: 'openai', telemetryEnabled: true, workspaceLabel: 'workspace', busy: false };
    const render = value => sidebar.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state } })), value);
    await render(state);
    assert.match(await sidebar.locator('body').innerText(), /OpenAI · Connected/);
    assert.match(await sidebar.locator('body').innerText(), /Ready/);
    assert.equal(await sidebar.locator('safe-id').count(), 0); // Text-only model IDs, no HTML injection.
    await sidebar.getByRole('button', { name: 'Configure models', exact: true }).focus();
    assert.equal(await sidebar.getByRole('button', { name: 'Configure models', exact: true }).evaluate(node => node === document.activeElement), true);
    for (const [connection, action, text] of [
      ['needs_reauthentication', 'connect', 'Reconnect'], ['permission_missing', 'connect', 'Reconnect'],
      ['usage_unavailable', 'retry', 'Retry'], ['error', 'retry', 'Retry']]) {
      await render({ ...state, view: 'needsAttention', activeProviderId: undefined, providers: [{ ...state.providers[0], connection, statusText: connection === 'needs_reauthentication' ? 'Sign in required' : text, description: connection === 'needs_reauthentication' ? 'Reconnect your ChatGPT account to continue.' : 'Connection needs attention.', autoAvailable: false, actions: [action, 'status'] }] });
      await sidebar.getByRole('button', { name: text, exact: true }).waitFor();
      assert.equal(await sidebar.getByRole('button', { name: 'New Chat', exact: true }).isDisabled(), true);
      if (connection === 'needs_reauthentication') await screenshot('ui04-reconnect.png');
    }
    await render({ ...state, view: 'needsAttention', providers: [{ ...state.providers[0], autoAvailable: false, description: 'MEDIUM model is not available.', mappings: state.providers[0].mappings.map(item => item.role === 'MEDIUM' ? { ...item, validity: 'unavailable' } : item) }] });
    assert.match(await sidebar.locator('body').innerText(), /Auto routing unavailable/);
    await screenshot('ui04-model-attention.png');
    const chat = { sessionId: 'fixture-session-123', providerId: 'openai', messages: [], autoOn: true, autoAvailable: true,
      models: [{ id: 'catalog-id', name: 'Catalog model' }], effortOptions: [], manualValid: false, running: false, canSend: true, status: '' };
    const conversation = { ...state, view: 'conversation', chat };
    const historyRows = [{ sessionId: chat.sessionId, title: 'อธิบาย NX Router architecture <script>literal</script>', createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-09T01:00:00.000Z', providerId: 'openai', status: 'interrupted' },
      { sessionId: 'history-second-123', title: 'Fix Sidebar tool status', createdAt: '2026-10-08T01:00:00.000Z', updatedAt: '2026-10-08T02:00:00.000Z', providerId: 'openai' }];
    const historyState = { ...state, view: 'sessions', chat, recentSessions: historyRows, history: { items: historyRows, query: '', offset: 0, hasMore: false } };

    await render(conversation);
    const prompt = sidebar.getByRole('textbox', { name: 'Ask NX', exact: true });
    await prompt.waitFor(); await screenshot('ui04-empty.png'); assert.equal(await sidebar.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    await prompt.fill('first line'); await prompt.press('Shift+Enter'); await prompt.press('x');
    assert.equal(await prompt.inputValue(), 'first line\nx');
    assert.equal(await sidebar.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
    await prompt.press('Enter'); assert.equal(await prompt.inputValue(), 'first line\nx', 'Rejected fixture Send preserves draft until host acceptance');
    await prompt.fill('');
    await prompt.fill('next draft');
    const message = { id: 'assistant-123', role: 'assistant', text: '<script>unsafe()</script> partial', status: 'running' };
    assert.equal(await sidebar.getByRole('switch', { name: 'Auto', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await sidebar.locator('.manual-controls').isVisible(), false);
    assert.equal(await sidebar.locator('label[for="prompt"]').evaluate(node => getComputedStyle(node).position), 'absolute');
    assert.doesNotMatch(await sidebar.locator('main').innerText(), /Start a conversation/);
    // IME Enter must leave the draft alone.
    await prompt.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    assert.equal(await prompt.inputValue(), 'next draft');
    await prompt.evaluate(node => node.setSelectionRange(2, 6));
    await render({ ...conversation, chat: { ...chat, running: true, canSend: false, status: 'Working… · MEDIUM · catalog-id', messages: [message] } });
    assert.equal(await prompt.inputValue(), 'next draft');
    assert.deepEqual(await prompt.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 6]);
    assert.equal(await prompt.evaluate(node => node === document.activeElement), true);
    assert.equal(await sidebar.locator('.message').count(), 1);
    assert.equal(await sidebar.locator('.message-text script').count(), 0);
    await sidebar.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    await render({ ...conversation, chat: { ...chat, messages: [{ ...message, text: message.text + ' complete', status: 'completed' }], status: 'completed · MEDIUM · catalog-id' } });
    assert.equal(await sidebar.locator('.message').count(), 1); assert.match(await sidebar.locator('.message-text').innerText(), /complete$/);
    assert.equal(await prompt.inputValue(), 'next draft');
    await render({ ...conversation, chat: { ...chat, autoOn: false, canSend: false, blockedReason: 'Choose an available Manual model and supported effort.' } });
    const model = sidebar.getByRole('combobox', { name: 'Model', exact: true });
    await model.waitFor(); assert.equal(await model.locator('option').count(), 2);
    const effort = sidebar.locator('#manual-effort');
    assert.equal(await sidebar.locator('#manual-effort').isVisible(), false);
    assert.equal(await sidebar.locator('#manual-effort option').allTextContents().then(values => values.join()), 'Default');
    assert.equal(await sidebar.locator('#manual-effort').isDisabled(), true); assert.equal(await sidebar.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    await render({ ...conversation, chat: { ...chat, autoOn: false, autoAvailable: false, canSend: true, manualModelId: 'catalog-id', manualValid: true } });
    assert.equal(await sidebar.getByRole('switch', { name: 'Auto', exact: true }).isDisabled(), true);
    assert.equal(await model.inputValue(), 'catalog-id');
    await render({ ...conversation, providers: [{ ...state.providers[0], connection: 'needs_reauthentication', autoAvailable: false, actions: ['connect'] }],
      chat: { ...chat, autoOn: false, autoAvailable: false, canSend: false, messages: [{ ...message, status: 'cancelled' }], blockedReason: 'Reconnect OpenAI to send a message.' } });
    await sidebar.getByRole('button', { name: 'Reconnect', exact: true }).waitFor();
    assert.equal(await sidebar.locator('.message').count(), 1);
    const manyMessages = Array.from({ length: 40 }, (_, index) => ({ id: `message-${index}`, role: 'assistant', text: ('Safe text line\n').repeat(4), status: 'completed' }));
    await render({ ...conversation, chat: { ...chat, sessionId: 'scroll-session-123', messages: manyMessages } });
    await sidebar.locator('#thread').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    await render({ ...conversation, chat: { ...chat, sessionId: 'scroll-session-123', messages: [...manyMessages, { id: 'last', role: 'assistant', text: 'latest text', status: 'running' }] } });
    assert.equal(await sidebar.locator('#thread').evaluate(node => node.scrollTop), 0);
    const markdown = '# Workspace overview\n\nNX uses **shared routing** and *native review*. Read `README.md`.\n\n- Safe tools\n- Bounded execution\n\n1. Inspect\n2. Verify\n\n```ts\nconst shared = ' + 'x'.repeat(220) + ';\n```\n\n[Docs](https://example.org/docs) [Unsafe](javascript:alert) [Command](command:bad)\n<img src=x onerror="window.injected=true"> <script>window.injected=true</script>';
    const turn = { messageId: message.id, mode: 'auto', status: 'completed', route: 'HIGH', modelId: 'catalog-id', modelName: 'Catalog model',
      escalation: { from: 'MEDIUM', to: 'HIGH', completed: true }, tools: [
        { id: 'read', label: 'Read', target: 'README.md', lineRange: '1–200', state: 'success', durationMs: 8 },
        { id: 'check', label: 'Check diagnostics', state: 'success', durationMs: 3 },
        { id: 'one', label: 'Edit', target: 'src/one.ts', state: 'success', durationMs: 20 },
        { id: 'two', label: 'Edit', target: 'src/two.ts', state: 'success', durationMs: 25 },
        { id: 'edit', label: 'Edit', target: 'src/router.ts', state: 'rejected', durationMs: 23 }
      ], changedFiles: ['src/one.ts', 'src/two.ts'] };
    const richMessage = { ...message, text: markdown, status: 'completed', turn };
    const richChat = { ...chat, sessionId: 'theme-session-123', messages: [{ id: 'user', role: 'user', text: 'Review and update workspace files' }, richMessage], status: 'Completed' };
    await render({ ...conversation, chat: richChat });
    assert.equal(await sidebar.locator('.message-text h3').innerText(), 'Workspace overview');
    assert.equal(await sidebar.locator('.message-text strong').innerText(), 'shared routing');
    assert.equal(await sidebar.locator('.message-text em').innerText(), 'native review');
    assert.equal(await sidebar.locator('.message-text ul li').count(), 2); assert.equal(await sidebar.locator('.message-text ol li').count(), 2);
    assert.equal(await sidebar.locator('.message-text img, .message-text script').count(), 0);
    assert.equal(await sidebar.evaluate(() => window.injected), undefined);
    assert.equal(await sidebar.locator('.message-text a').count(), 1);
    assert.match(await sidebar.locator('.assistant > .muted').innerText(), /✓ Completed · ↑ MEDIUM → HIGH · Catalog model/);
    assert.doesNotMatch(await sidebar.locator('main').innerText(), /Default|structuredData|stdout|Waiting for VS Code approval/);
    const copyResponse = sidebar.locator('.copy-response');
    assert.equal(await copyResponse.count(), 1);
    assert.equal(await copyResponse.getAttribute('aria-label'), 'Copy response');
    assert.equal(await copyResponse.innerText(), '');
    assert.equal(await copyResponse.locator('svg').count(), 1);
    await copyResponse.click(); await copyResponse.locator('svg').waitFor();
    await sidebar.locator('.copy-response[data-copy-state="copied"]').waitFor();
    const splitter = sidebar.getByRole('separator', { name: 'Resize conversation and input' });
    const heights = () => sidebar.evaluate(() => ({ input: document.querySelector('textarea').getBoundingClientRect().height,
      thread: document.querySelector('#thread').clientHeight, composer: document.querySelector('.composer').offsetHeight }));
    const beforeSplit = await heights();
    await prompt.fill('Draft survives resizing');
    await prompt.evaluate(node => node.setSelectionRange(3, 8));
    const splitBox = await splitter.boundingBox(); assert.ok(splitBox);
    await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y + splitBox.height / 2); await page.mouse.down();
    await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y - 100, { steps: 8 }); await page.mouse.up();
    const expandedSplit = await heights();
    assert.ok(expandedSplit.input >= beforeSplit.input + 95, 'Dragging up enlarges input');
    assert.ok(expandedSplit.thread <= beforeSplit.thread - 95, 'Dragging up shares conversation space');
    assert.deepEqual(await prompt.evaluate(node => [node.value, node.selectionStart, node.selectionEnd, node === document.activeElement]), ['Draft survives resizing', 3, 8, true]);
    assert.equal(await prompt.evaluate(node => getComputedStyle(node).resize), 'none');
    await splitter.focus(); await page.keyboard.press('ArrowDown');
    assert.equal((await heights()).composer, expandedSplit.composer - 16);
    await page.keyboard.press('End'); assert.ok((await heights()).thread >= 60, 'Maximum preserves readable thread');
    await page.keyboard.press('Home'); assert.ok((await heights()).input >= 48, 'Minimum preserves writable input');
    await splitter.dblclick();
    await sidebar.getByRole('button', { name: 'Copy code', exact: true }).click();
    await sidebar.getByRole('button', { name: 'Copy code', exact: true }).filter({ hasText: 'Copied' }).waitFor();
    const readDetails = sidebar.locator('details').filter({ has: sidebar.locator('summary', { hasText: 'Read README.md' }) });
    await readDetails.locator('summary').click(); assert.equal(await readDetails.getAttribute('open'), '');
    assert.match(await readDetails.innerText(), /1–200/); assert.match(await readDetails.innerText(), /8 ms/);
    assert.match(await sidebar.getByText('2 files changed', { exact: true }).innerText(), /2 files changed/);
    // Streaming reconciles Markdown elements and keeps focused Copy and expanded summaries alive.
    await sidebar.getByRole('button', { name: 'Copy code', exact: true }).focus();
    await render({ ...conversation, chat: { ...richChat, running: true, messages: [{ ...richMessage, text: markdown + '\nNext token', status: 'running', turn: { ...turn, status: 'running' } }] } });
    assert.equal(await sidebar.getByRole('button', { name: 'Copy code', exact: true }).evaluate(node => node === document.activeElement), true);
    assert.equal(await readDetails.getAttribute('open'), '');
    assert.equal(await copyResponse.getAttribute('aria-label'), 'Copy response');
    assert.equal(await copyResponse.innerText(), '');
    await copyResponse.click(); await sidebar.locator('.copy-response[data-copy-state="copied"]').waitFor();
    assert.equal(await copyResponse.count(), 1);
    assert.equal(await sidebar.locator('.message-text').last().innerText().then(text => text.match(/Next token/g)?.length), 1);
    for (const status of ['completed', 'partial', 'cancelled', 'failed', 'interrupted']) {
      await render({ ...conversation, chat: { ...richChat, messages: [{ ...richMessage, status, turn: { ...turn, status } }] } });
      const labels = { completed: 'Completed', partial: 'Partially completed', cancelled: 'Cancelled', failed: 'Failed', interrupted: 'Interrupted' };
      assert.match(await sidebar.locator('.assistant > .muted').innerText(), new RegExp(labels[status]));
    }
    await render({ ...conversation, chat: { ...richChat, autoOn: false, manualModelId: 'catalog-id', manualValid: true,
      effortOptions: ['high'], manualEffort: 'high', messages: [{ ...richMessage, turn: { ...turn, mode: 'manual', effort: 'high', escalation: undefined } }] } });
    assert.equal(await effort.isVisible(), true); assert.equal(await effort.inputValue(), 'high');
    assert.match(await sidebar.locator('.assistant > .muted').innerText(), /Manual · Catalog model · high/);
    assert.equal(await sidebar.getByRole('switch', { name: 'Auto', exact: true }).getAttribute('aria-checked'), 'false');
    // Host-only choice changes must not relabel a previous turn.
    await render({ ...state, chat: richChat });
    const back = sidebar.getByRole('button', { name: 'Return to chat', exact: true });
    assert.equal(await back.getAttribute('class'), 'primary');
    assert.notEqual(await sidebar.getByRole('button', { name: 'New Chat', exact: true }).getAttribute('class'), 'primary');
    const positions = await sidebar.evaluate(() => ['.home-navigation button:first-child', '.home-navigation button:last-child', '#settings'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect(); return { center: box.y + box.height / 2, right: box.right };
    }));
    assert.ok(Math.abs(positions[0].center - positions[2].center) < 2, 'Return to chat and Settings align');
    assert.ok(Math.abs(positions[1].center - positions[2].center) < 2, 'New Chat and Settings align');
    assert.ok(positions[1].right < positions[2].right, 'Settings stays at the right of navigation');
    await sidebar.getByRole('button', { name: 'New Chat', exact: true }).focus(); await page.keyboard.press('Tab');
    assert.equal(await sidebar.locator('#settings').evaluate(node => node === document.activeElement), true);
    await screenshot('ui04-home.png');
    const contextChips = [
      { id: 'file-context-123', descriptor: { kind: 'file', path: 'README.md' }, label: 'README.md' },
      { id: 'selection-context-123', descriptor: { kind: 'selection', path: 'src/router.ts', startLine: 24, startCharacter: 0, endLine: 41, endCharacter: 8 }, label: 'Selection · src/router.ts 24–41' },
      { id: 'diagnostics-context-123', descriptor: { kind: 'diagnostics', count: 3, omitted: 2 }, label: 'Diagnostics · 3 items (2 omitted)' },
      { id: 'git-context-123', descriptor: { kind: 'git_diff', count: 2 }, label: 'Git diff · 2 files' },
      { id: 'image-context-123', descriptor: { kind: 'image', path: 'Screenshot.png', scope: 'external' }, label: 'Image · Screenshot.png · External' },
      { id: 'long-context-123', descriptor: { kind: 'file', path: 'src/very-long-directory-name/long-file-name.ts' }, label: 'src/very-long-directory-name/long-file-name.ts' }
    ];
    await render({ ...conversation, chat: { ...chat, sessionId: 'context-visual-123', contextAvailable: true } });
    await sidebar.getByRole('button', { name: 'Add Context', exact: true }).focus();
    assert.equal(await sidebar.getByRole('button', { name: 'Add Context', exact: true }).evaluate(node => document.activeElement === node), true);
    await screenshot('ui06-empty.png');
    await render({ ...conversation, chat: { ...chat, sessionId: 'context-visual-123', contextAvailable: true, draftContext: contextChips.slice(0, 1) } });
    await sidebar.getByRole('button', { name: 'Remove README.md', exact: true }).focus();
    assert.equal(await sidebar.getByRole('button', { name: 'Remove README.md', exact: true }).evaluate(node => document.activeElement === node), true);
    await screenshot('ui06-file.png');
    for (const [index, name] of [[1, 'selection'], [2, 'diagnostics'], [3, 'git']]) {
      await render({ ...conversation, chat: { ...chat, sessionId: 'context-visual-123', draftContext: [contextChips[index]] } });
      assert.equal(await sidebar.locator('.context-chips [role="listitem"]').count(), 1);
      await screenshot(`ui06-${name}.png`);
      await screenshot(`ui07-${name}.png`);
    }
    await render({ ...conversation, chat: { ...chat, sessionId: 'context-visual-123', draftContext: contextChips, contextNotice: 'Context unavailable. Remove or reselect the missing file and retry.' } });
    assert.match(await sidebar.locator('.composer [role="alert"]').innerText(), /reselect/);
    await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).fill('Draft survives a context error');
    await screenshot('ui06-error.png');
    await render({ ...conversation, chat: { ...chat, sessionId: 'context-visual-123', draftContext: contextChips, autoOn: false, manualValid: true, manualModelId: 'catalog-id' } });
    assert.equal(await sidebar.locator('.manual-controls').isVisible(), true);
    assert.equal(await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).inputValue(), 'Draft survives a context error');
    await screenshot('ui06-manual.png');
    const visualChat = { ...richChat, draftContext: contextChips, contextAvailable: true, messages: [{ ...richChat.messages[0], references: contextChips.map(ref => ref.descriptor) }, { ...richMessage, text: '# Workspace overview\n\nNX uses **shared routing** and *native review*. Read `README.md`.\n\n- Safe workspace tools\n- Bounded execution\n\n```ts\nconst runtime = getSharedRuntime();\nconst result = await runtime.run(turn, emit);\n```\n\n[Documentation](https://example.org/docs)' }] };
    await render({ ...conversation, chat: visualChat });
    assert.equal(await sidebar.locator('.historical-context button').count(), 0);
    assert.equal(await sidebar.locator('.historical-context [role="listitem"]').count(), contextChips.length);
    await render({ ...conversation, chat: { ...visualChat, sessionId: 'history-context-visual-123', draftContext: [], messages: [visualChat.messages[0], { id: 'short-context-answer', role: 'assistant', text: 'Read-only reference summary.', status: 'completed' }] } });
    await screenshot('ui06-historical.png');
    await render({ ...conversation, chat: visualChat });
    const switchChat = { ...visualChat, sessionId: 'provider-visual-123', providerId: 'boundary-fixture', providerLabel: 'Local Provider B', providerPickerAvailable: true,
      segments: [{ id: 'segment-visual-a', sessionId: 'provider-visual-123', providerId: 'openai', providerLabel: 'OpenAI', startIndex: 0, contextCarryMode: 'fresh' },
        { id: 'segment-visual-b', sessionId: 'provider-visual-123', providerId: 'boundary-fixture', providerLabel: 'Local Provider B', startIndex: 2, contextCarryMode: 'fresh' }],
      messages: [...visualChat.messages, { id: 'provider-b-user', role: 'user', text: 'Continue with a fresh provider segment' },
        { id: 'provider-b-answer', role: 'assistant', text: 'Only this segment’s conversation was provided.', status: 'completed', turn: { ...richMessage.turn, providerId: 'boundary-fixture', providerLabel: 'Local Provider B', modelName: 'Local B model', tools: [], changedFiles: [] } }] };
    await render({ ...conversation, chat: { ...visualChat, providerPickerAvailable: false } });
    assert.equal(await sidebar.getByRole('button', { name: 'Switch provider', exact: true }).isVisible(), false);
    await screenshot('ui07-one-provider.png');
    await render({ ...conversation, chat: switchChat });
    assert.equal(await sidebar.getByRole('button', { name: 'Switch provider', exact: true }).isVisible(), true);
    assert.match(await sidebar.locator('.provider-boundary').innerText(), /OpenAI → Local Provider B.*Continue fresh/);
    await prompt.fill('Retained draft'); await sidebar.getByRole('button', { name: 'Switch provider', exact: true }).focus();
    await screenshot('ui07-multi-provider.png');
    assert.equal(await prompt.inputValue(), 'Retained draft');
    await render({ ...conversation, chat: { ...switchChat, sessionId: 'switch-new-draft-123', preserveDraftFromSessionId: switchChat.sessionId, messages: [], segments: [] } });
    assert.equal(await prompt.inputValue(), 'Retained draft', 'Switch Start new chat retains draft text');
    await render({ ...conversation, chat: { ...switchChat, canSend: false, autoAvailable: false, blockedReason: 'Provider Local Provider B unavailable. Reconnect or explicitly switch provider.' } });
    assert.equal(await sidebar.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
    assert.equal(await sidebar.locator('.provider-boundary').count(), 1);
    await screenshot('ui07-unavailable.png');
    await render({ ...conversation, chat: { ...switchChat, segments: switchChat.segments.map((segment, index) => index ? { ...segment, contextCarryMode: 'selected', carryCount: 2 } : segment) } });
    assert.match(await sidebar.locator('.provider-boundary').innerText(), /2 context items selected to carry/);
    await screenshot('ui07-selected-boundary.png');
    await render({ ...conversation, chat: switchChat });
    fs.mkdirSync(path.join(root, '.test-results'), { recursive: true });
    for (const [theme, className, name] of [
      ['Default Light Modern', 'vscode-light', 'light'], ['Default Dark Modern', 'vscode-dark', 'dark'],
      ['Default High Contrast', 'vscode-high-contrast', 'high-contrast']]) {
      const settingsPath = path.join(profile, 'User', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath)); settings['workbench.colorTheme'] = theme;
      fs.writeFileSync(settingsPath, JSON.stringify(settings));
      await sidebar.waitForFunction(className => document.body.classList.contains(className), className);
      const buttonSurfaces = await sidebar.locator('button:visible').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return { label: node.textContent, background: style.backgroundColor, border: style.borderTopColor, width: style.borderTopWidth, borderStyle: style.borderTopStyle, cursor: style.cursor };
      }));
      for (const surface of buttonSurfaces) {
        assert.notEqual(surface.background, 'rgba(0, 0, 0, 0)', `${name}: ${surface.label} needs a visible button surface`);
        assert.notEqual(surface.border, 'rgba(0, 0, 0, 0)', `${name}: ${surface.label} needs a visible boundary`);
        assert.equal(surface.width, '1px'); assert.equal(surface.borderStyle, 'solid');
        assert.equal(surface.cursor, 'pointer', `${name}: ${surface.label} needs a hand cursor`);
      }
      await sidebar.locator('#settings').hover();
      assert.equal(await sidebar.locator('#settings svg').evaluate(node => getComputedStyle(node).cursor), 'pointer');
      await sidebar.getByRole('switch', { name: 'Auto', exact: true }).hover();
      assert.equal(await sidebar.getByRole('switch', { name: 'Auto', exact: true }).evaluate(node => getComputedStyle(node).cursor), 'pointer');
      await screenshot(`ui04-${name}.png`);
      await screenshot(`ui06-${name}.png`);
      await screenshot(`ui07-${name}.png`);
      await render(historyState);
      assert.equal(await sidebar.getByRole('searchbox', { name: 'Search chats', exact: true }).evaluate(node => node === document.activeElement), true);
      assert.equal(await sidebar.locator('.session-open[aria-current="true"]').count(), 1);
      assert.equal(await sidebar.locator('.session-open script').count(), 0);
      assert.match(await sidebar.locator('.session-open').first().getAttribute('aria-label'), /Current chat/);
      assert.equal(await sidebar.getByRole('button', { name: /^Delete chat:/ }).count(), 2);
      assert.equal(await sidebar.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await screenshot(`ui05-history-${name}.png`);
      await render({ ...conversation, chat: switchChat });
    }
    // Real Sidebar resize, then workbench zoom using the standard native command.
    const sideBox = await page.locator('.part.sidebar').boundingBox();
    assert.ok(sideBox);
    const sash = await page.locator('.monaco-sash.vertical').all();
    let resize;
    for (const item of sash) { const box = await item.boundingBox(); if (box && Math.abs(box.x - (sideBox.x + sideBox.width)) < 8 && box.height > 200) { resize = box; break; } }
    assert.ok(resize, 'Sidebar resize sash');
    await page.mouse.move(resize.x + resize.width / 2, resize.y + 100); await page.mouse.down();
    await page.mouse.move(sideBox.x + 260, resize.y + 100); await page.mouse.up();
    await sidebar.waitForFunction(() => window.innerWidth <= 280);
    assert.equal(await sidebar.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await sidebar.locator('pre').evaluate(node => node.scrollWidth > node.clientWidth), true);
    await screenshot('ui04-narrow.png');
    await screenshot('ui06-narrow.png');
    await screenshot('ui07-narrow.png');
    assert.equal(await sidebar.locator('.context-chips').evaluate(node => node.clientHeight <= 78), true);
    assert.equal(await sidebar.getByRole('textbox', { name: 'Ask NX', exact: true }).evaluate(node => node.getBoundingClientRect().height >= 48), true);
    // Keyboard tab access and native details expansion.
    await sidebar.getByRole('button', { name: 'Home', exact: true }).focus(); await page.keyboard.press('Tab');
    assert.equal(await sidebar.getByRole('button', { name: 'New Chat', exact: true }).evaluate(node => node === document.activeElement), true);
    await sidebar.locator('.tool-activity summary').first().focus(); await page.keyboard.press('Enter');
    assert.equal(await sidebar.locator('.tool-activity details').first().getAttribute('open'), '');
    const settingsPath = path.join(profile, 'User', 'settings.json');
    const zoomSettings = JSON.parse(fs.readFileSync(settingsPath)); zoomSettings['window.zoomLevel'] = 1;
    fs.writeFileSync(settingsPath, JSON.stringify(zoomSettings));
    await sidebar.waitForFunction(() => window.devicePixelRatio > 1.1);
    assert.equal(await sidebar.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const textareaBox = await prompt.boundingBox(); const sendBox = await sidebar.getByRole('button', { name: 'Send', exact: true }).boundingBox();
    assert.ok(textareaBox && sendBox);
    await sidebar.waitForFunction(() => {
      const send = document.querySelector('.execution-controls > button.primary');
      return send.getBoundingClientRect().bottom <= window.innerHeight && document.querySelector('textarea').getBoundingClientRect().top >= 0;
    });
    const cdp = await page.context().newCDPSession(page);
    const captureSize = await page.evaluate(() => ({ width: window.innerWidth * window.devicePixelRatio, height: window.innerHeight * window.devicePixelRatio }));
    const zoomCapture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, ...captureSize, scale: 1 } });
    fs.writeFileSync(path.join(root, '.test-results', 'ui04-zoom.png'), Buffer.from(zoomCapture.data, 'base64'));
    fs.writeFileSync(path.join(root, '.test-results', 'ui07-zoom.png'), Buffer.from(zoomCapture.data, 'base64'));
    fs.writeFileSync(path.join(root, '.test-results', 'ui06-zoom.png'), Buffer.from(zoomCapture.data, 'base64'));
    await cdp.detach();
    await render({ ...state, chat, recentSessions: historyRows });
    assert.equal(await sidebar.locator('.session-open').count(), 2);
    assert.equal(await sidebar.locator('.session-open[aria-current="true"]').count(), 1);
    await screenshot('ui05-home-narrow.png');
    await render(historyState);
    const search = sidebar.getByRole('searchbox', { name: 'Search chats', exact: true });
    await search.fill('ภาษาไทย'); await search.evaluate(node => node.setSelectionRange(1, 4));
    await render({ ...historyState, history: { ...historyState.history, query: 'ภาษาไทย', items: historyRows.slice(0, 1) } });
    assert.equal(await search.inputValue(), 'ภาษาไทย');
    assert.deepEqual(await search.evaluate(node => [node.selectionStart, node.selectionEnd]), [1, 4]);
    assert.equal(await search.evaluate(node => node === document.activeElement), true);
    await search.press('Tab');
    assert.equal(await sidebar.locator('.session-open').first().evaluate(node => node === document.activeElement), true);
    assert.equal(await sidebar.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const historyWidth = await sidebar.evaluate(() => window.innerWidth);
    for (const control of await sidebar.locator('.session-open, .session-delete').all()) { const bounds = await control.evaluate(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; }); assert.ok(bounds.left >= 0 && bounds.right <= historyWidth, 'History row controls fit narrow Sidebar'); }
    await screenshot('ui05-history-narrow.png');
    console.log('UI-05 history UI passed: summary rows/current/date, text-only titles, labelled search, retained focus/caret, keyboard rows, visible delete, light/dark/high contrast and narrow zoom.');
    console.log('UI-04 Sidebar UI passed: actual first-run/native Settings; safe Markdown/code/full-response Copy and injection rejection; pointer/keyboard splitter, bounds and retained draft/selection; actual status/escalation/Manual projection; accessible Auto ON/OFF/disabled; catalog/capability controls; Enter/newline/IME; draft/caret/focus/scroll; expanded details; Home hierarchy; light/dark/high contrast; narrow width and zoom with anchored visible Send.');
    console.log('UI-06 context visual checks passed: empty/file/selection/diagnostics/Git/multiple wrapped chips, accessible Remove, error/draft, read-only historical descriptors, Manual, themes/narrow/zoom; no document overflow.');
    console.log('UI-07 one/multiple provider control, fresh/selected boundaries, unavailable Send, draft preservation, themes/narrow/zoom passed. Native keyboard dialogs are checked by the restart harness.');
    console.log('Connected states use injected sanitized fixtures; no real OpenAI account was used.');
  } finally { if (browser) await browser.close(); child.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
