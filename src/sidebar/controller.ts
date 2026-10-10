import * as vscode from 'vscode';
import { OpenAIAvailabilityMonitor } from '../runtime/openaiAvailabilityMonitor';
import { SidebarMessage, SidebarState, sidebarState, parseSidebarMessage, safeExternalLink } from './state';
import type { ChatSessionStore, SessionPage } from './sessionStore';
import { SidebarAdapter } from './adapter';

export interface SidebarBackend {
  id: string;
  label?: string;
  commands: { connect: string; configureModels: string; status: string };
}
/** Host-authoritative navigation, command and chat message boundary. */
export class SidebarController implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SidebarState>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private conversation = false;
  private history?: SessionPage & { query: string };
  private searchGeneration = 0;
  private busy = false;
  private notice?: string;
  private refreshFailed = false;
  constructor(private readonly monitor: OpenAIAvailabilityMonitor, private readonly backends: readonly SidebarBackend[],
    private readonly environment: () => { telemetryEnabled: boolean; workspaceLabel: string },
    private readonly execute: (command: string, ...args: unknown[]) => Thenable<unknown> = vscode.commands.executeCommand,
    private readonly adapter?: SidebarAdapter,
    private readonly confirmDelete: () => Promise<boolean> = async () => await vscode.window.showWarningMessage('Delete this saved chat? This cannot be undone.', { modal: true }, 'Delete chat') === 'Delete chat') {
    this.subscriptions = [monitor.onDidChange(() => { this.refreshFailed = false; this.adapter?.reconcile(); this.publish(); })];
  }
  state(): SidebarState {
    const environment = this.environment();
    const state = sidebarState(this.monitor.state(), environment.telemetryEnabled, environment.workspaceLabel,
      this.conversation, this.busy, this.notice);
    if (this.refreshFailed) {
      state.view = 'needsAttention'; state.activeProviderId = undefined;
      state.providers = this.backends.map(backend => ({ id: backend.id, label: backend.label ?? backend.id,
        connection: 'error', statusText: 'Status unavailable', description: 'Provider status is temporarily unavailable. Retry or inspect connection status.',
        actions: ['retry', 'status', 'connect'], autoAvailable: false, mappings: [] }));
    }
    state.chat = this.adapter?.snapshot(this.conversation && !this.history);
    state.linkedProviders = this.adapter?.providers.summaries();
    if (state.linkedProviders?.length) {
      state.activeProviderId = state.chat?.providerId ?? state.linkedProviders.find(provider => provider.selectable)?.id;
      for (const provider of state.linkedProviders) {
        const existing = state.providers.find(item => item.id === provider.id);
        if (existing) { existing.label = provider.label; continue; }
        state.providers.push({ id: provider.id, label: provider.label, connection: provider.selectable ? 'connected' : 'error',
          statusText: provider.selectable ? 'Connected' : 'Unavailable', description: provider.selectable ? '' : 'Provider unavailable. History stays visible.',
          actions: [], autoAvailable: this.adapter!.providers.state(provider.id).auto, mappings: [] });
      }
      if (state.view === 'firstRun' && state.linkedProviders.some(provider => provider.selectable)) state.view = 'home';
    }
    state.historyAvailable = this.adapter?.persistent === true;
    state.recentSessions = this.adapter?.recent();
    state.notice = this.adapter?.persistenceNotice ?? state.notice;
    if (this.history) { state.view = 'sessions'; state.history = this.history; }
    if (state.chat && this.conversation && !this.history) { state.view = 'conversation'; }
    if (state.chat && this.refreshFailed) { state.chat.canSend = false; state.chat.autoAvailable = false; state.chat.blockedReason = 'Retry connection status before sending.'; }
    if (state.chat && state.view !== 'conversation') state.chat.messages = [];
    return state;
  }
  async changeWorkspace(store?: ChatSessionStore): Promise<void> {
    this.busy = true; ++this.searchGeneration; this.history = undefined; this.conversation = false;
    try { await this.adapter?.changeWorkspace(store); } finally { this.busy = false; this.publish(); }
  }
  publish(): void { this.changed.fire(this.state()); }
  async refresh(discover = false): Promise<void> {
    try { if (this.adapter) await this.adapter.refreshProviders(discover); else await this.monitor.refresh(discover); this.refreshFailed = false; this.publish(); }
    catch { this.refreshFailed = true; this.publish(); }
  }
  async receive(input: unknown): Promise<boolean> {
    const message = parseSidebarMessage(input, this.adapter?.providers.manager?.all().map(provider => provider.id) ?? this.backends.map(provider => provider.id));
    if (!message) { return false; }
    if (message.type === 'provider' && !this.backends.some(backend => backend.id === message.providerId)) return false;
    if (this.adapter) await this.adapter.initialize();
    if (message.type === 'clipboard/copy') { await vscode.env.clipboard.writeText(message.text); return true; }
    if (message.type === 'link/open') { return vscode.env.openExternal(vscode.Uri.parse(safeExternalLink(message.url)!)); }
    if (message.type === 'ready') { this.publish(); await this.refresh(); return true; }
    if (message.type === 'sessions/search') {
      if (!this.history || this.busy) return false;
      const generation = ++this.searchGeneration;
      const page = await this.adapter?.search(message.query, message.offset);
      if (page && generation === this.searchGeneration && this.history) { this.history = { ...page, query: message.query }; this.publish(); }
      return true;
    }
    if (['sessions/viewAll', 'navigation/sessions', 'sessions/open', 'sessions/delete'].includes(message.type)) {
      if (!this.adapter || this.busy) return false;
      this.busy = true; this.publish(); ++this.searchGeneration;
      try {
        if (message.type === 'sessions/open') {
          if (!await this.adapter.open(message.sessionId)) { this.notice = 'This chat could not be opened. Other saved chats are still available.'; return false; }
          this.history = undefined; this.conversation = true; this.notice = undefined;
        } else if (message.type === 'sessions/delete') {
          if (!await this.confirmDelete()) return true;
          const current = this.adapter.matches(message.sessionId);
          await this.adapter.delete(message.sessionId);
          if (current) this.conversation = false;
          if (this.history) this.history = { ...await this.adapter.search(this.history.query), query: this.history.query };
        } else {
          await this.adapter.leave();
          this.history = { ...await this.adapter.search(''), query: '' }; this.conversation = false;
        }
      } catch { this.notice = 'The local history action could not be completed. Try again.'; }
      finally { this.busy = false; this.publish(); }
      return true;
    }
    if ('sessionId' in message) {
      if (!this.adapter?.matches(message.sessionId)) { return false; }
      if (message.type === 'chat/stop') { return this.adapter.stop(); }
      if (this.busy) { return false; }
      if (message.type === 'provider/openPicker') {
        this.busy = true; this.publish();
        try { return await this.adapter.chooseProvider(); }
        catch { this.notice = 'Provider switch could not be completed. Check availability and local storage.'; return false; }
        finally { this.busy = false; this.publish(); }
      }
      if (message.type === 'context/openPicker') { this.busy = true; this.publish(); try { return await this.adapter.addContext(); } finally { this.busy = false; this.publish(); } }
      if (message.type === 'context/remove') return this.adapter.removeContext(message.id);
      if (message.type === 'context/clear') { if (this.adapter.snapshot()?.running) return false; this.adapter.clearContext(); this.publish(); return true; }
      if (message.type === 'chat/send') { if (this.refreshFailed) { return false; } return this.adapter.send(message.text); }
      if (message.type === 'execution/setAuto') { return this.adapter.setAuto(message.on); }
      if (message.type === 'execution/selectModel') { return this.adapter.selectModel(message.providerId, message.modelId); }
      if (message.type === 'execution/selectEffort') { return this.adapter.selectEffort(message.effort); }
    }
    if (this.busy) { return false; }
    if (message.type === 'navigation/conversation') {
      if (!this.adapter?.snapshot()) { return false; } this.history = undefined; ++this.searchGeneration; this.conversation = true; this.publish(); return true;
    }
    if (message.type === 'newChat' || message.type === 'chat/new' || message.type === 'home' || message.type === 'navigation/home') {
      const isNew = message.type === 'newChat' || message.type === 'chat/new';
      if (isNew && !(this.adapter?.providers.summaries().some(provider => provider.selectable) ?? this.state().activeProviderId)) { return false; }
      if (isNew) { this.busy = true; this.publish(); try { await this.adapter?.newChat(); } catch { this.notice = 'Save the current chat before starting a new one.'; this.publish(); return false; } finally { this.busy = false; this.publish(); } }
      if (!isNew) { this.busy = true; try { await this.adapter?.leave(); } finally { this.busy = false; } }
      this.history = undefined; ++this.searchGeneration; this.conversation = isNew; this.notice = undefined; this.publish(); return true;
    }
    this.busy = true; this.notice = undefined; this.publish();
    try { await this.dispatch(message); }
    catch { this.notice = 'The action could not be completed. Check connection status and try again.'; }
    finally { this.busy = false; await this.refresh(); this.publish(); }
    return true;
  }
  private async dispatch(message: SidebarMessage): Promise<void> {
    if (message.type === 'settings') { await this.execute('workbench.action.openSettings', '@ext:nx-router.nx-router'); }
    else if (message.type === 'telemetry') { await this.execute('nxRouter.telemetryStatus'); }
    else if (message.type === 'provider') {
      const backend = this.backends.find(provider => provider.id === message.providerId)!;
      if (message.action === 'retry') { await this.refresh(true); }
      else { await this.execute(backend.commands[message.action]); }
    }
  }
  dispose(): void { this.subscriptions.forEach(item => item.dispose()); this.adapter?.dispose(); this.changed.dispose(); }
}
