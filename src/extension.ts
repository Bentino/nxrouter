import * as vscode from 'vscode';
import { nativeReferences } from './runtime/contextSources';
import { createVsCodeEnricher } from './enrichment';
import { Telemetry } from './telemetry';
import { DiffContent, verifyFixture } from './workspace';
import { isolatedTools } from './evidence';
import { NxSessionState, parseSessionState } from './sessionState';
import { ProductionTool } from './worker/productionTools';
import { productionTools } from './worker/toolPolicy';
import { retentionDays } from './config';
import { NxRuntime } from './runtime/nxRuntime';
import { NxProviderManager, VsCodeLmProvider, activeProfile } from './runtime/providers';
import { OpenAIAuth } from './runtime/openaiAuth';
import { OpenAIConfiguration, OpenAIProvider } from './runtime/openaiProvider';
import { ExecutionSessions } from './runtime/executionSessions';
import { OpenAIAvailabilityMonitor } from './runtime/openaiAvailabilityMonitor';
import { newId } from './telemetry';
import { SidebarController } from './sidebar/controller';
import { SidebarViewProvider } from './sidebar/viewProvider';
import { sidebarViewId } from './sidebar/state';
import { ChatSessionStore, workspaceSessionKey } from './sidebar/sessionStore';
import { SidebarAdapter } from './sidebar/adapter';

let telemetry: Telemetry;
let fixturesRegistered = false;
let providers: NxProviderManager;
let openai: OpenAIProvider;
let executionSessions: ExecutionSessions;
let availabilityMonitor: OpenAIAvailabilityMonitor;
let runtime: NxRuntime;
let settingsRefresh: ReturnType<typeof setTimeout> | undefined;
let sidebarAdapter: SidebarAdapter | undefined;
let latestSessionId: string | undefined;

export function previousState(context: vscode.ChatContext): NxSessionState | undefined {
  for (const turn of [...context.history].reverse()) {
    if (turn instanceof vscode.ChatResponseTurn && turn.participant === 'nx-router.spike') {
      return parseSessionState(turn.result.metadata?.nxSessionState);
    }
  }
  return undefined;
}
export function openAIStatusText(config: OpenAIConfiguration): string {
  const rows = (['Router', 'LOW', 'MEDIUM', 'HIGH'] as const).map(role => {
    const mapping = config.mappings[role];
    return `${role.padEnd(6)} -> ${mapping.modelId ?? 'unconfigured'} (${mapping.validity})`;
  });
  return `OpenAI / ChatGPT connection\n\nState: ${config.state.replaceAll('_', ' ')}\nSelected profile reference: ${config.profileId ?? 'none'}\nAuto available: ${config.auto.available ? 'yes' : 'no'}\n\nUser Settings mappings:\n${rows.join('\n')}\n`;
}

export const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
  const previous = previousState(context);
  const priorTurn = [...context.history].reverse().find(turn => turn instanceof vscode.ChatResponseTurn && turn.participant === 'nx-router.spike') as vscode.ChatResponseTurn | undefined;
  const priorMetadata = priorTurn?.result.metadata?.nxTurn as { providerId?: string; segmentId?: string } | undefined;
  const priorExecution = priorTurn?.result.metadata?.nxExecution as { sessionId?: string; autoOn?: boolean; manual?: { modelId: string; effort?: string } } | undefined;
  let references;
  try { references = await nativeReferences(request.references); }
  catch { stream.markdown('Context could not be resolved. Choose supported workspace text files or a smaller selection and retry.'); return { errorDetails: { message: 'Context unavailable.' } }; }
  for (const reference of request.references) {
    if (reference.value instanceof vscode.Uri || reference.value instanceof vscode.Location) stream.reference(reference.value);
  }
  const fixture = fixturesRegistered && vscode.workspace.getConfiguration('nxRouter.worker').get<boolean>('fixtureModels', false);
  const sessionId = previous?.sessionId ?? priorExecution?.sessionId ?? newId();
  const availability = fixture ? true : (await availabilityMonitor.refresh()).auto.available;
  if (!executionSessions.has(sessionId) && priorExecution?.sessionId === sessionId) {
    executionSessions.restore(sessionId, { autoOn: priorExecution.autoOn === true, manual: priorExecution.manual }, availability);
  }
  const sessionExecution = executionSessions.getOrCreate(sessionId, availability);
  if (!sessionExecution.autoOn && !sessionExecution.manual) {
    stream.markdown('Auto is OFF. Configure OpenAI Models, then start a new chat session or explicitly re-enable Auto when the session control is available.');
    return { errorDetails: { message: 'Auto is OFF for this session.' }, metadata: { nxExecution: { sessionId, ...sessionExecution } } };
  }
  const profile = fixture ? activeProfile(true) : openai.profile();
  const result = await runtime.run({ text: request.prompt, references, previous, command: request.command,
    sessionId, previousProviderId: priorMetadata?.providerId, segmentId: priorMetadata?.segmentId,
    execution: sessionExecution.autoOn ? { mode: 'auto', providerId: profile.providerId } :
      { mode: 'manual', providerId: profile.providerId, model: sessionExecution.manual! }, profile, token,
    toolInvocationToken: request.toolInvocationToken, enrich: createVsCodeEnricher(request.references) },
    event => { if (event.type === 'textDelta') { stream.markdown(event.text); } });
  result.metadata = { ...result.metadata, nxExecution: { sessionId, ...executionSessions.getOrCreate(sessionId, availability) } };
  return result;
};

export function activate(context: vscode.ExtensionContext): void {
  fixturesRegistered = process.env.NX_ROUTER_FIXTURES === '1' &&
    !!context.extension.packageJSON.contributes?.languageModelChatProviders?.some((item: { vendor: string }) => item.vendor === 'nx-spike');
  telemetry = new Telemetry(context);
  openai = new OpenAIProvider(new OpenAIAuth(context), context.globalState);
  executionSessions = new ExecutionSessions();
  availabilityMonitor = new OpenAIAvailabilityMonitor(openai, executionSessions, message => {
    void vscode.window.showWarningMessage(message, 'Configure Models').then(action => {
      if (action === 'Configure Models') { void vscode.commands.executeCommand('nxRouter.configureOpenAIModels'); }
    });
  });
  providers = new NxProviderManager(fixturesRegistered ? [openai, new VsCodeLmProvider('nx-spike', 'NX test fixture')] : [openai]);
  runtime = new NxRuntime(telemetry, providers, id => { latestSessionId = id; });
  const historyOutput = vscode.window.createOutputChannel('NX Router History');
  context.subscriptions.push(historyOutput);
  const createHistory = () => {
    const folders = vscode.workspace.workspaceFolders;
    return vscode.workspace.isTrusted && !vscode.env.remoteName && folders?.length === 1 && folders[0].uri.scheme === 'file'
    ? new ChatSessionStore(vscode.Uri.joinPath(context.globalStorageUri, 'chat-sessions', workspaceSessionKey(folders[0].uri.toString())).fsPath,
      category => historyOutput.appendLine(category)) : undefined;
  };
  const history = createHistory();
  const adapter = sidebarAdapter = new SidebarAdapter(availabilityMonitor, executionSessions, runtime, () => openai.profile(), () => sidebar.publish(), history, undefined, providers);
  const sidebar = new SidebarController(availabilityMonitor, [{ id: openai.id, label: 'OpenAI', commands: {
    connect: 'nxRouter.connectOpenAI', configureModels: 'nxRouter.configureOpenAIModels', status: 'nxRouter.openAIStatus'
  } }], () => ({ telemetryEnabled: telemetry.enabled,
    workspaceLabel: vscode.workspace.workspaceFolders?.[0]?.name ?? 'No workspace open' }), vscode.commands.executeCommand, adapter);
  const sidebarView = new SidebarViewProvider(context.extensionUri, sidebar);
  context.subscriptions.push(sidebar, sidebarView, availabilityMonitor, openai, openai.auth,
    vscode.window.registerWebviewViewProvider(sidebarViewId, sidebarView),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void sidebar.changeWorkspace(createHistory()); }),
    openai.auth.onDidChangeConnection(() => { void sidebar.refresh(); }),
    openai.onDidChangeCatalog(() => { void sidebar.refresh(); }));
  void telemetry.applyRetention();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('nxRouter.telemetry.retentionDays') || event.affectsConfiguration('nxRouter.telemetry.enabled')) { void telemetry.applyRetention(); }
    if (event.affectsConfiguration('nxRouter')) { sidebar.publish(); }
    if (event.affectsConfiguration('nxRouter.providers.openai')) {
      clearTimeout(settingsRefresh);
      settingsRefresh = setTimeout(() => { void availabilityMonitor.refresh(); }, 150);
    }
  }));
  context.subscriptions.push(openai.auth.onDidChangeProfile(() => { void availabilityMonitor.refresh(true); }));
  context.subscriptions.push({ dispose: () => clearTimeout(settingsRefresh) });
  void (history ? adapter.initialize() : availabilityMonitor.refresh(true)).catch(() => sidebar.publish());
  const diff = new DiffContent();
  const participant = vscode.chat.createChatParticipant('nx-router.spike', handler);
  participant.iconPath = new vscode.ThemeIcon('hubot');
  context.subscriptions.push(participant,
    vscode.workspace.registerTextDocumentContentProvider('nx-router-diff', diff),
    vscode.commands.registerCommand('nxRouter.connectOpenAI', async () => {
      try {
        const status = await openai.auth.signIn(openai.auth.selectedProfile()?.id);
        if (status.state === 'permission_missing') { void vscode.window.showWarningMessage('OpenAI connected, but ChatGPT plan usage was not granted. Reconnect to enable it.'); return; }
        const models = await openai.listModels();
        void vscode.window.showInformationMessage(`OpenAI connected. ${models.length} selectable models discovered. Configure Router and worker models next.`);
      } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'OpenAI connection failed.'); }
      finally { await sidebar.refresh(); }
    }),
    vscode.commands.registerCommand('nxRouter.openAIStatus', async () => {
      try {
        const config = await openai.configuration();
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'plaintext', content: openAIStatusText(config) }));
      } catch { void vscode.window.showErrorMessage('OpenAI status is temporarily unavailable.'); }
    }),
    vscode.commands.registerCommand('nxRouter.configureOpenAIModels', async () => {
      try {
        const models = await openai.listModels();
        if (!models.length) { void vscode.window.showWarningMessage('This ChatGPT account has no selectable models.'); return; }
        const chosenModels: Array<{ role: 'Router' | 'LOW' | 'MEDIUM' | 'HIGH'; modelId: string }> = [];
        for (const role of ['Router', 'LOW', 'MEDIUM', 'HIGH'] as const) {
          const chosen = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: model.id, modelId: model.id })),
            { title: `NX Router: OpenAI ${role} model`, placeHolder: 'Choose an available model (provider default effort)' });
          if (!chosen) { return; }
          chosenModels.push({ role, modelId: chosen.modelId });
        }
        for (const chosen of chosenModels) { await openai.setMapping(chosen.role, { modelId: chosen.modelId }); }
        clearTimeout(settingsRefresh);
        await availabilityMonitor.refresh();
        void vscode.window.showInformationMessage('OpenAI Router and worker models configured.');
      } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'OpenAI model setup failed.'); }
    }),
    vscode.commands.registerCommand('nxRouter.testOpenAI', async () => {
      const result = await openai.testConnection(openai.profile().auto.router.modelId || undefined);
      const message = `OpenAI test: connection ${result.connection}; model discovery ${result.modelDiscovery}; inference ${result.inference}; model ${result.model ?? 'unavailable'}; ${result.durationMs} ms.${result.message ? ` ${result.message}` : ''}`;
      if (result.inference === 'OK') { void vscode.window.showInformationMessage(message); } else { void vscode.window.showErrorMessage(message); }
    }),
    vscode.commands.registerCommand('nxRouter.disconnectOpenAI', async () => {
      const result = await openai.auth.disconnect();
      void vscode.window.showInformationMessage(result.revoked ? 'OpenAI disconnected.' : 'OpenAI disconnected locally. Remote revocation was not confirmed; manage access in ChatGPT Settings.');
    }),
    vscode.commands.registerCommand('nxRouter.telemetryStatus', async () => {
      const data = await telemetry.export(latestSessionId) as { summary: Record<string, number | null> };
      const s = data.summary;
      const content = `NX Router telemetry\n\nTelemetry: ${telemetry.enabled ? 'enabled' : 'disabled'}\nRetention: ${retentionDays()} days\nLatest NX session handled by this extension host: ${latestSessionId ?? 'unavailable'}\n\nTurns: ${s.turns}\nRouter requests: ${s.router_requests}\nWorker requests: ${s.worker_requests}\nLOW worker requests: ${s.low_worker_requests}\nMEDIUM worker requests: ${s.medium_worker_requests}\nHIGH worker requests: ${s.high_worker_requests}\nEscalations: ${s.escalations}\nEstimated API-equivalent cost: ${s.estimated_api_equivalent_cost_usd === null ? 'unavailable' : `$${s.estimated_api_equivalent_cost_usd?.toFixed(6)}`}\n`;
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'plaintext', content }));
    }),
    vscode.commands.registerCommand('nxRouter.exportSessionTelemetry', async () => {
      if (!telemetry.enabled) { void vscode.window.showInformationMessage('NX telemetry is disabled; no telemetry is available for this session.'); return; }
      if (!latestSessionId) { void vscode.window.showInformationMessage('No NX chat session has run in this extension host.'); return; }
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(await telemetry.export(latestSessionId), null, 2) });
      await vscode.window.showTextDocument(document);
    }),
    ...([['nxRouter.clearSessionTelemetry', 'latest NX session handled by this extension host'], ['nxRouter.clearWorkspaceTelemetry', 'workspace'], ['nxRouter.clearAllTelemetry', 'all sessions']] as const).map(([command, label]) =>
      vscode.commands.registerCommand(command, async () => {
        if (command === 'nxRouter.clearSessionTelemetry' && !latestSessionId) { void vscode.window.showInformationMessage('No NX chat session has run in this extension host.'); return; }
        const answer = await vscode.window.showWarningMessage(`Clear NX telemetry for ${label}?`, { modal: true }, 'Clear');
        if (answer !== 'Clear') { return; }
        await telemetry.clear(command === 'nxRouter.clearSessionTelemetry' ? latestSessionId : undefined, label === 'workspace');
        void vscode.window.showInformationMessage(`Cleared NX telemetry for ${label}.`);
      })),
    ...Object.values(productionTools).map(name => vscode.lm.registerTool(name, new ProductionTool(name, diff))),
    vscode.lm.registerTool('nx_request_escalation', {
      invoke: async () => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Escalation control is handled by the NX worker loop.')])
    }),
    // Production registrations end here.

  );
  if (fixturesRegistered) {
    const { AutoProvider } = require('./acceptance') as typeof import('./acceptance');
    const { IsolatedTool, WorkspaceTool } = require('./tool') as typeof import('./tool');
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider('nx-spike', new AutoProvider()),
      vscode.lm.registerTool('nx_spike_workspace', new WorkspaceTool(diff)),
      ...Object.entries(isolatedTools).map(([operation, name]) => vscode.lm.registerTool(name, new IsolatedTool(diff, operation as 'read' | 'write' | 'verify' | 'dangerous'))),
    vscode.commands.registerCommand('nxRouter.cancellationTask', async () => {
      const source = new vscode.CancellationTokenSource();
      try {
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NX cancellation Task fixture', cancellable: true },
          async (_progress, token) => {
            const listener = token.onCancellationRequested(() => source.cancel());
            if (token.isCancellationRequested) { source.cancel(); }
            try { return await verifyFixture(source.token, 10000); } finally { listener.dispose(); }
          });
        void vscode.window.showInformationMessage(result);
      } catch (error) {
        void vscode.window.showInformationMessage(error instanceof vscode.CancellationError ? 'NX fixture Task cancelled.' : String(error));
      } finally { source.dispose(); }
    }),
    vscode.commands.registerCommand('nxRouter.acceptanceEvidence', async () => {
      const { inspectProfile } = await import('./test/profile');
      const { acceptanceEvents } = await import('./evidence');
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ profile: await inspectProfile(), acceptanceEvents }, null, 2) });
      await vscode.window.showTextDocument(document);
    }),
    vscode.commands.registerCommand('nxRouter.openSpike', async () => {
      // Warm discovery before opening chat; a fresh profile can otherwise submit before
      // VS Code has any selected model and reject the request before our handler runs.
      await vscode.lm.selectChatModels({ vendor: 'nx-spike' });
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@nx read', isPartialQuery: true });
    })
    );
  }
}

export async function deactivate(): Promise<void> { await sidebarAdapter?.shutdown(); }
