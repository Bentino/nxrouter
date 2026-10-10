import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { OpenAIConfiguration, OpenAIProvider } from '../runtime/openaiProvider';
import { OpenAIAvailabilityMonitor } from '../runtime/openaiAvailabilityMonitor';
import { ExecutionSessions } from '../runtime/executionSessions';
import { validateAutoMapping } from '../runtime/autoConfiguration';
import { SidebarController } from '../sidebar/controller';
import { sidebarState, parseSidebarMessage, sidebarViewId } from '../sidebar/state';
import { sidebarHtml, SidebarViewProvider } from '../sidebar/viewProvider';

export function configuration(state: OpenAIConfiguration['state'] = 'connected', valid = true): OpenAIConfiguration {
  const auto = validateAutoMapping({ providerId: 'openai', auto: { router: { modelId: 'real-catalog-id' },
    tiers: { LOW: { modelId: 'real-catalog-id' }, MEDIUM: { modelId: valid ? 'real-catalog-id' : '' }, HIGH: { modelId: 'real-catalog-id' } }
  } }, ['real-catalog-id'], state === 'connected');
  return { state, providerId: 'openai', profileId: 'PRIVATE_PROFILE', modelMappingComplete: auto.available, auto,
    mappings: Object.fromEntries(Object.entries(auto.mappings).map(([role, item]) => [role, {
      modelId: item.modelId, effort: 'provider default', available: item.valid, validity: item.validity
    }])) as OpenAIConfiguration['mappings'] };
}
export async function sidebarTests(test: (name: string, fn: () => Promise<void>) => Promise<void>): Promise<void> {
  await test('UI-02 production Sidebar contributions use NX Router identity and local assets', async () => {
    const root = path.resolve(__dirname, '../..');
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.contributes.views.nxRouter, [{ id: sidebarViewId, name: 'NX Router', type: 'webview' }]);
    const container = manifest.contributes.viewsContainers.activitybar[0];
    assert.equal(container.id, 'nxRouter'); assert.equal(container.title, 'NX Router');
    assert.doesNotMatch(JSON.stringify([container, manifest.contributes.views]), /spike|fixture|debug/i);
    for (const name of [container.icon, 'media/sidebar.js', 'media/sidebar.css']) {
      assert.ok((await fs.stat(path.join(root, name))).size > 0);
    }
    assert.equal(manifest.contributes.chatParticipants[0].name, 'nx');
  });
  await test('UI-02 normalized first-run, attention, connected and Auto-ready projection excludes secrets', async () => {
    const firstRun = sidebarState(configuration('not_connected'), true, 'workspace');
    assert.equal(firstRun.view, 'firstRun'); assert.deepEqual(firstRun.providers[0].actions, ['connect']);
    assert.equal(sidebarState(configuration(), true, 'workspace').view, 'home');
    assert.equal(sidebarState(configuration(), true, 'workspace').providers[0].autoAvailable, true);
    const invalid = sidebarState(configuration('connected', false), false, 'No workspace open');
    assert.equal(invalid.view, 'needsAttention'); assert.equal(invalid.providers[0].autoAvailable, false);
    assert.ok(invalid.providers[0].actions.includes('configureModels')); assert.match(invalid.providers[0].description, /MEDIUM model is not configured/);
    for (const state of ['connecting', 'needs_reauthentication', 'permission_missing', 'usage_unavailable', 'error'] as const) {
      const result = sidebarState(configuration(state), true, 'workspace');
      assert.equal(result.view, 'needsAttention'); assert.equal(result.providers[0].connection, state);
      assert.equal(result.providers[0].autoAvailable, false);
      assert.ok(result.providers[0].description);
      if (state === 'needs_reauthentication' || state === 'permission_missing') assert.ok(result.providers[0].actions.includes('connect'));
    }
    const dirty = Object.assign(configuration(), { accessToken: 'ACCESS_SECRET', refreshToken: 'REFRESH_SECRET',
      subject: 'SUBJECT_SECRET', rawCatalog: 'RAW_CATALOG', identityClaims: 'RAW_CLAIMS' });
    assert.doesNotMatch(JSON.stringify(sidebarState(dirty, true, 'workspace')), /SECRET|RAW_|PRIVATE_PROFILE|profileId|effort/);
  });
  await test('UI-02 untrusted messages reject arbitrary commands, settings and provider IDs', async () => {
    for (const input of [null, [], 'settings', {}, { type: 'command', command: 'nxRouter.disconnectOpenAI' },
      { type: 'settings', extra: true }, { type: 'provider', providerId: 'openai', action: 'setMapping' },
      { type: 'provider', providerId: 'unknown', action: 'connect' },
      { type: 'provider', providerId: 'openai', action: 'connect', token: 'SECRET' }]) {
      assert.equal(parseSidebarMessage(input, ['openai']), undefined);
    }
    assert.deepEqual(parseSidebarMessage({ type: 'provider', providerId: 'openai', action: 'connect' }, ['openai']),
      { type: 'provider', providerId: 'openai', action: 'connect' });
  });
  await test('UI-02 command adapter reuses backend, native settings and navigation without runtime calls', async () => {
    let current = configuration('not_connected');
    const provider = { configuration: async () => current, refreshConfiguration: async () => current } as OpenAIProvider;
    const monitor = new OpenAIAvailabilityMonitor(provider, new ExecutionSessions(), () => {});
    const calls: unknown[][] = [];
    const controller = new SidebarController(monitor, [{ id: 'openai', commands: {
      connect: 'existing.connect', configureModels: 'existing.models', status: 'existing.status'
    } }], () => ({ telemetryEnabled: true, workspaceLabel: 'workspace' }), async (...args) => {
      calls.push(args); if (args[0] === 'existing.connect') current = configuration();
    });
    try {
      await controller.receive({ type: 'ready' }); assert.equal(controller.state().view, 'firstRun');
      assert.equal(await controller.receive({ type: 'provider', providerId: 'openai', action: 'connect' }), true);
      assert.equal(controller.state().view, 'home');
      await controller.receive({ type: 'provider', providerId: 'openai', action: 'configureModels' });
      await controller.receive({ type: 'settings' }); await controller.receive({ type: 'telemetry' });
      assert.deepEqual(calls, [['existing.connect'], ['existing.models'], ['workbench.action.openSettings', '@ext:nx-router.nx-router'], ['nxRouter.telemetryStatus']]);
      const before = calls.length;
      assert.equal(await controller.receive({ type: 'provider', providerId: 'openai', action: 'disconnect' }), false);
      assert.equal(calls.length, before);
      await controller.receive({ type: 'newChat' }); assert.equal(controller.state().view, 'conversation');
      await controller.receive({ type: 'home' }); assert.equal(controller.state().view, 'home');
      current = configuration('needs_reauthentication'); await monitor.refresh();
      assert.equal(controller.state().view, 'needsAttention');
      current = configuration('connected', false); await monitor.refresh();
      assert.equal(controller.state().providers[0].autoAvailable, false);
      current = configuration(); await monitor.refresh(); assert.equal(controller.state().providers[0].autoAvailable, true);
    } finally { controller.dispose(); monitor.dispose(); }
  });
  await test('UI-02 Webview CSP, local roots, ready handshake, visibility and disposal', async () => {
    const uri = vscode.Uri.file('/extension');
    const messages: unknown[] = [];
    const received = new vscode.EventEmitter<unknown>(), visible = new vscode.EventEmitter<void>(), disposed = new vscode.EventEmitter<void>();
    const webview = { cspSource: 'vscode-webview:', asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: async (message: unknown) => { messages.push(message); return true; }, onDidReceiveMessage: received.event } as unknown as vscode.Webview;
    const html = sidebarHtml(webview, uri);
    assert.match(html, /default-src 'none'/); assert.match(html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(html, /connect-src 'none'/); assert.doesNotMatch(html, /unsafe-inline|unsafe-eval|https?:/);
    const nonce = html.match(/script-src 'nonce-([^']+)'/)![1]; assert.ok(html.includes(`nonce="${nonce}"`));
    let refreshes = 0;
    const monitor = new OpenAIAvailabilityMonitor({ configuration: async () => { refreshes++; return configuration('not_connected'); } } as OpenAIProvider,
      new ExecutionSessions(), () => {});
    const controller = new SidebarController(monitor, [{ id: 'openai', commands: { connect: 'connect', configureModels: 'models', status: 'status' } }],
      () => ({ telemetryEnabled: true, workspaceLabel: 'workspace' }));
    const provider = new SidebarViewProvider(uri, controller);
    const view = { webview, visible: true, onDidChangeVisibility: visible.event, onDidDispose: disposed.event } as vscode.WebviewView;
    try {
      provider.resolveWebviewView(view);
      assert.equal(webview.options.enableScripts, true);
      assert.deepEqual(webview.options.localResourceRoots?.map(root => root.path), ['/extension/media']);
      await controller.receive({ type: 'ready' }); assert.ok(messages.length >= 2);
      assert.equal((messages.at(-1) as { state: { view: string } }).state.view, 'firstRun');
      const before = refreshes; visible.fire(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(refreshes, before + 1);
      disposed.fire(); const count = messages.length; controller.publish(); assert.equal(messages.length, count);
    } finally { provider.dispose(); controller.dispose(); monitor.dispose(); received.dispose(); visible.dispose(); disposed.dispose(); }
  });
  await test('UI-02 unavailable backend status produces actionable error and recovers on retry', async () => {
    let fail = true;
    const read = async () => { if (fail) throw new Error('ACCESS_SECRET'); return configuration(); };
    const monitor = new OpenAIAvailabilityMonitor({ configuration: read, refreshConfiguration: read } as OpenAIProvider,
      new ExecutionSessions(), () => {});
    const controller = new SidebarController(monitor, [{ id: 'openai', label: 'OpenAI', commands: {
      connect: 'connect', configureModels: 'models', status: 'status'
    } }], () => ({ telemetryEnabled: true, workspaceLabel: 'workspace' }));
    try {
      await controller.refresh();
      assert.equal(controller.state().view, 'needsAttention');
      assert.deepEqual(controller.state().providers[0].actions, ['retry', 'status', 'connect']);
      assert.equal(controller.state().providers[0].autoAvailable, false);
      assert.doesNotMatch(JSON.stringify(controller.state()), /ACCESS_SECRET/);
      fail = false; await monitor.refresh(); // External account/settings revalidation also clears attention.
      assert.equal(controller.state().view, 'home');
      fail = true; await controller.refresh();
      fail = false; await controller.receive({ type: 'provider', providerId: 'openai', action: 'retry' });
      assert.equal(controller.state().view, 'home'); assert.equal(controller.state().providers[0].autoAvailable, true);
    } finally { controller.dispose(); monitor.dispose(); }
  });
  await test('UI-02 command failure remains sanitized and busy state suppresses duplicate actions', async () => {
    const monitor = new OpenAIAvailabilityMonitor({ configuration: async () => configuration('not_connected') } as OpenAIProvider,
      new ExecutionSessions(), () => {});
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const controller = new SidebarController(monitor, [{ id: 'openai', commands: { connect: 'connect', configureModels: 'models', status: 'status' } }],
      () => ({ telemetryEnabled: false, workspaceLabel: 'workspace' }), async () => { await pending; throw new Error('ACCESS_SECRET'); });
    try {
      await controller.refresh();
      const flight = controller.receive({ type: 'provider', providerId: 'openai', action: 'connect' });
      assert.equal(controller.state().busy, true);
      assert.equal(await controller.receive({ type: 'provider', providerId: 'openai', action: 'connect' }), false);
      finish(); await flight;
      assert.equal(controller.state().busy, false); assert.ok(controller.state().notice);
      assert.doesNotMatch(JSON.stringify(controller.state()), /ACCESS_SECRET/);
    } finally { controller.dispose(); monitor.dispose(); }
  });
}
