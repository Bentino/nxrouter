import { ContextSources, ContextError, DraftReference, contextAvailable, draftReferenceKey } from '../runtime/contextSources';
import { referenceLabel, referenceDescriptor, referenceLimits, NxReferenceDescriptor, validateReferences, ReferenceValidationError } from '../runtime/references';
import * as vscode from 'vscode';
import { newId } from '../telemetry';
import { NxRuntime, NxRuntimeEvent, NxUserTurn } from '../runtime/nxRuntime';
import { nativeProviderPicker, ProviderPicker } from './providerPicker';
import { SidebarProviders } from './providerState';
import { NxProviderManager, NxProviderProfile } from '../runtime/providers';
import { ExecutionSessions } from '../runtime/executionSessions';
import { OpenAIAvailabilityMonitor } from '../runtime/openaiAvailabilityMonitor';
import { workspaceIdentity, toolActivity, verificationLabel } from '../worker/toolActivity';
import { ChatSessionStore, SessionPage, sessionTitle } from './sessionStore';
import { SidebarChatSession, SidebarChatSnapshot, ChatTurn } from './session';

/** Adapts UI state/events only; Router, Worker, tools, safety and telemetry remain in NxRuntime. */
export class SidebarAdapter implements vscode.Disposable {
  private session?: SidebarChatSession;
  readonly providers: SidebarProviders;
  private preserveDraftFromSessionId?: string;
  private carryNeedsReselection = false;
  private committing = false;
  private active?: { source: vscode.CancellationTokenSource; done: Promise<void>; accepted: boolean };
  private draftContext: DraftReference[] = [];
  contextNotice?: string;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private initialization?: Promise<void>;
  persistenceNotice?: string;
  private touching(): void { if (this.session) this.session.updatedAt = new Date().toISOString(); }
  initialize(): Promise<void> {
    return this.initialization ??= (async () => {
      try { await this.providers.refresh(true); } catch { /* History remains available offline. */ }
      if (!this.store) return;
      await this.store.initialize();
      try { await this.monitor.refresh(true); } catch { /* History remains readable offline. */ }
      if (this.store.lastActive) {
        const saved = await this.store.load(this.store.lastActive);
        if (saved && !this.disposed) { this.session = saved; this.restoreExecution(); }
      }
      if (!this.disposed) this.publish();
    })();
  }
  private restoreExecution(): void {
    if (!this.session) return;
    const segment = this.session.segments?.at(-1);
    this.carryNeedsReselection = segment?.contextCarryMode === 'selected' && !!segment.carryCount && segment.startIndex >= this.session.messages.length;
    if (this.carryNeedsReselection) this.contextNotice = 'Selected carried context was not retained after reload. Attach the intended context again before sending.';
    this.executions.bind(this.session.sessionId, this.session.providerId);
    this.executions.restore(this.session.sessionId, this.session.execution, this.providers.state(this.session.providerId).auto);
    this.reconcile();
  }
  get persistent(): boolean { return !!this.store; }
  recent() { return this.store?.list() ?? []; }
  async search(query: string, offset = 0): Promise<SessionPage> {
    await this.initialize();
    return this.store?.search(query, offset) ?? { items: [], offset, hasMore: false };
  }
  async open(id: string): Promise<boolean> {
    await this.initialize(); if (!this.store) return false;
    this.stop(); await this.active?.done; await this.save();
    if (this.persistenceNotice) return false;
    const saved = await this.store.load(id);
    if (!saved || this.disposed) { this.publish(); return false; }
    if (this.session) this.executions.delete(this.session.sessionId);
    this.clearContext(); this.session = saved; this.restoreExecution();
    await this.save(); this.publish(); return true;
  }
  async delete(id: string): Promise<boolean> {
    await this.initialize(); if (!this.store || !await this.store.load(id)) return false;
    if (this.matches(id)) { await this.newChat(); }
    await this.store.delete(id); this.publish(); return true;
  }
  private checkpoint(immediate = false): void {
    this.touching();
    if (!this.store) return;
    if (immediate) { void this.save(); }
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.save(); }, 1000);
  }
  async save(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.committing) { await this.store?.flush(); return; }
    if (!this.store || !this.session) return;
    try { await this.store.save(this.session); this.persistenceNotice = undefined; }
    catch { this.persistenceNotice = 'Chat could not be saved locally. Check local storage and retry before reloading.'; }
    if (!this.disposed) this.publish();
  }
  async changeWorkspace(store?: ChatSessionStore): Promise<void> {
    await this.leave();
    if (this.session) this.executions.delete(this.session.sessionId);
    this.clearContext(); this.session = undefined; this.store = store; this.initialization = undefined; this.persistenceNotice = undefined;
    await this.initialize(); this.publish();
  }
  async leave(): Promise<void> { this.stop(); await this.active?.done; await this.save(); }
  async shutdown(): Promise<void> { this.stop(); await this.active?.done; await this.save(); await this.store?.flush(); }

  constructor(private readonly monitor: OpenAIAvailabilityMonitor, private readonly executions: ExecutionSessions,
    private readonly runtime: Pick<NxRuntime, 'run'>, private readonly profile: () => NxProviderProfile,
    private readonly publish: () => void, private store?: ChatSessionStore, private readonly context = new ContextSources(), manager?: NxProviderManager, private readonly picker: ProviderPicker = nativeProviderPicker) { this.providers = new SidebarProviders(monitor, manager); }
  reconcile(): void {
    if (this.committing) return;
    if (this.session) {
      const previousAuto = this.session.execution.autoOn;
      this.session.execution = this.executions.getOrCreate(this.session.sessionId, this.providers.state(this.session.providerId).auto);
      if (previousAuto !== this.session.execution.autoOn) this.checkpoint(true);
      if (!this.providers.state(this.session.providerId).connected) { this.active?.source.cancel(); }
    }
  }
  async refreshProviders(discover = false): Promise<void> { await this.providers.refresh(discover); this.reconcile(); }
  async newChat(providerId?: string, preserveDraftFromSessionId?: string): Promise<void> {
    await this.initialize();
    if (!providerId) {
      await this.refreshProviders();
      const linked = this.providers.summaries().filter(item => item.selectable);
      if (linked.length > 1) {
        const picked = await this.picker.pick([...linked].sort((a, b) => Number(b.id === this.session?.providerId) - Number(a.id === this.session?.providerId)).map(item => ({ label: item.label, id: item.id })), { title: 'New Chat provider', placeHolder: 'Choose a provider for the fresh chat' });
        if (!picked) return;
        providerId = picked.id;
      } else if (linked.length === 1) providerId = linked[0].id;
    }
    this.stop();
    await this.active?.done;
    await this.save();
    if (this.persistenceNotice) throw new Error('Save chat before switching');
    if (this.disposed) { return; }
    providerId ??= this.session?.providerId ?? this.profile().providerId;
    await this.refreshProviders();
    if (!this.providers.summaries().some(item => item.id === providerId && item.selectable)) throw new Error('Provider unavailable');
    if (this.session) this.executions.delete(this.session.sessionId);
    this.clearContext();
    const sessionId = newId(), now = new Date().toISOString();
    this.session = { sessionId, title: 'New chat', createdAt: now, updatedAt: now, segmentId: newId(), providerId, messages: [],
      execution: this.executions.getOrCreate(sessionId, this.providers.state(providerId).auto) };
    this.executions.bind(sessionId, providerId);
    this.preserveDraftFromSessionId = preserveDraftFromSessionId;
    this.session.segments = [this.segment(providerId, 0, 'fresh')];
    this.session.segmentId = this.session.segments[0].id;
    await this.store?.activate();
    this.publish();
  }
  snapshot(includeMessages = true): SidebarChatSnapshot | undefined {
    const session = this.session;
    if (!session) { return; }
    const config = this.providers.state(session.providerId);
    const connected = config.connected;
    const models = connected ? config.models : [];
    const manual = session.execution.manual;
    const model = models.find(model => model.id === manual?.modelId);
    const manualValid = !!model && (!manual?.effort || model.effortOptions.includes(manual.effort));
    const autoAvailable = config.auto === true && connected;
    const running = !!this.active;
    const blockedReason = this.carryNeedsReselection ? 'Attach the intended carried context again before sending.' : !connected ? `Provider ${config.label} unavailable. Reconnect or explicitly switch provider.` : session.execution.autoOn
      ? !autoAvailable ? 'Configure this provider’s models to use Auto.' : undefined
      : !manualValid ? 'Choose an available Manual model and supported effort.' : undefined;
    const turn = session.turn;
    const executionLabel = turn ? this.executionLabel(turn) : undefined;
    const labels = { running: 'Working…', completed: 'Completed', partial: 'Partially completed', cancelled: 'Cancelled', failed: 'Failed', interrupted: 'Interrupted' };
    return { preserveDraftFromSessionId: this.preserveDraftFromSessionId, providerLabel: config.label, providerPickerAvailable: this.providers.summaries().filter(item => item.selectable).length > 1 || (!connected && this.providers.summaries().some(item => item.selectable)), segments: session.segments?.map(segment => ({ ...segment })), draftContext: this.draftContext.map(ref => ({ id: ref.id, descriptor: { ...ref.descriptor }, label: referenceLabel(ref.descriptor) })), contextAvailable: contextAvailable(), contextNotice: this.contextNotice, sessionId: session.sessionId, providerId: session.providerId,
      messages: includeMessages ? session.messages.map(message => ({ id: message.id, segmentId: message.segmentId, role: message.role, text: message.text, createdAt: message.createdAt, status: message.status,
        ...(message.references ? { references: message.references.map(referenceDescriptor).filter((ref): ref is NxReferenceDescriptor => !!ref) } : {}),
        ...(message.turn ? { turn: this.projectTurn(message.turn) } : {}) })) : [],
      autoOn: session.execution.autoOn, autoAvailable, manualModelId: manual?.modelId, manualEffort: manual?.effort,
      models: models.map(model => ({ id: model.id, name: model.name })), effortOptions: [...(model?.effortOptions ?? [])], manualValid,
      running, canSend: !running && !blockedReason, blockedReason,
      status: running ? this.active?.source.token.isCancellationRequested ? 'Stopping…' : 'Working…' : turn ? labels[turn.status] : '', executionLabel };
  }
  matches(sessionId: string): boolean { return sessionId === this.session?.sessionId; }
  setAuto(on: boolean): boolean {
    if (!this.session || this.active || (on && !this.snapshot()?.autoAvailable)) { return false; }
    this.session.execution = this.executions.setAuto(this.session.sessionId, on, this.snapshot()!.autoAvailable);
    this.checkpoint(true); this.publish(); return true;
  }
  selectModel(providerId: string, modelId: string): boolean {
    const session = this.session, snapshot = this.snapshot();
    if (!session || this.active || snapshot?.autoOn || providerId !== session.providerId || !snapshot?.models.some(model => model.id === modelId)) { return false; }
    session.execution = this.executions.setManual(session.sessionId, { modelId });
    this.checkpoint(true); this.publish(); return true;
  }
  selectEffort(effort: string): boolean {
    const session = this.session, snapshot = this.snapshot();
    if (!session || this.active || snapshot?.autoOn || !snapshot?.manualValid || (effort !== 'default' && !snapshot.effortOptions.includes(effort))) { return false; }
    session.execution = this.executions.setManual(session.sessionId, { modelId: session.execution.manual!.modelId,
      ...(effort !== 'default' ? { effort } : {}) });
    this.checkpoint(true); this.publish(); return true;
  }
  clearContext(): void { this.draftContext = []; this.contextNotice = undefined; this.carryNeedsReselection = false; }
  removeContext(id: string): boolean {
    if (this.active || !this.draftContext.some(ref => ref.id === id)) return false;
    this.draftContext = this.draftContext.filter(ref => ref.id !== id); this.contextNotice = undefined; this.publish(); return true;
  }
  async addContext(): Promise<boolean> {
    if (!this.session || this.active) return false;
    const session = this.session;
    try {
      const added = await this.context.pick();
      if (session !== this.session || this.active) return false;
      const next = [...this.draftContext];
      const keys = new Set(await Promise.all(next.map(ref => draftReferenceKey(ref.descriptor, ref.selectedFile))));
      for (const item of added) {
        const descriptor = referenceDescriptor(item.descriptor);
        if (!descriptor) throw new ContextError('Invalid context. Attach again.');
        const key = await draftReferenceKey(descriptor, item.selectedFile);
        if (!keys.has(key)) { next.push({ ...item, descriptor, id: newId() }); keys.add(key); }
      }
      if (next.length > referenceLimits.count) throw new ContextError('Attach at most 8 context items.');
      this.draftContext = next;
      if (added.length) { this.carryNeedsReselection = false; this.contextNotice = undefined; }
      return true;
    } catch (error) {
      this.contextNotice = error instanceof ContextError || error instanceof ReferenceValidationError ? error.message : 'Context unavailable. Check the selected file, remove or reselect context, and retry.'; return false;
    } finally { this.publish(); }
  }
  send(text: string): Promise<boolean> {
    if (!text.trim() || text.length > 16000 || !this.session || this.active || !this.snapshot()?.canSend || this.disposed) { return Promise.resolve(false); }
    // Reserve before any await so duplicate bridge sends cannot race validation.
    const source = new vscode.CancellationTokenSource();
    const active = { source, done: Promise.resolve(), accepted: false };
    this.active = active;
    active.done = this.run(this.session, text, source).finally(async () => {
      await this.save();
      source.dispose(); if (this.active === active) { this.active = undefined; }
      if (!this.disposed) { this.publish(); }
    });
    this.publish();
    return active.done.then(() => active.accepted);
  }
  private async run(session: SidebarChatSession, text: string, source: vscode.CancellationTokenSource): Promise<void> {
    let assistant: SidebarChatSession['messages'][number] | undefined;
    try {
      const execution: NxUserTurn['execution'] = session.execution.autoOn ? { mode: 'auto', providerId: session.providerId }
        : { mode: 'manual', providerId: session.providerId, model: { ...session.execution.manual! } };
      await this.refreshProviders();
      const snapshot = this.snapshot()!;
      if (source.token.isCancellationRequested) throw new vscode.CancellationError();
      if (snapshot.blockedReason || (execution.mode === 'auto' && !snapshot.autoAvailable)) throw new Error('Execution unavailable.');
      const references = await this.context.materialize(this.draftContext);
      validateReferences(references);
      if (source.token.isCancellationRequested) throw new vscode.CancellationError();
      if (this.active) this.active.accepted = true;
      this.clearContext();
      const conversation = session.messages.filter(message => (!message.segmentId || message.segmentId === session.segmentId)).filter(message => message.role === 'user' || message.status === 'completed' || message.status === 'partial')
        .slice(-10).map(message => ({ role: message.role, text: message.text }));
      const now = new Date().toISOString();
      if (!session.messages.some(message => message.role === 'user' && message.text.trim())) session.title = sessionTitle(text);
      assistant = { id: newId(), segmentId: session.segmentId, role: 'assistant', text: '', createdAt: now, status: 'running' };
      session.messages.push({ id: newId(), segmentId: session.segmentId, role: 'user', text, createdAt: now, references: references.map(ref => referenceDescriptor(ref.descriptor)).filter((ref): ref is NxReferenceDescriptor => !!ref) }, assistant);
      session.turn = { providerId: session.providerId, providerLabel: configLabel(this.providers, session.providerId), messageId: assistant.id, mode: execution.mode, status: 'running', tools: [], changedFiles: [] };
      assistant.turn = session.turn;
      this.touching(); await this.save(); this.publish();
      const result = await this.runtime.run({ sessionId: session.sessionId, segmentId: session.segmentId, text, references,
        previous: session.rolling, previousProviderId: session.providerId, conversation, execution, profile: this.providers.profile(session.providerId, this.profile), providerSwitch: { manual: (session.segments?.length ?? 0) > 1 && session.segments?.at(-1)?.startIndex === session.messages.length - 2, carryMode: session.segments?.at(-1)?.contextCarryMode ?? 'fresh' }, token: source.token },
        event => { this.event(session, assistant!, event); this.checkpoint(event.type === 'toolResult'); if (!this.disposed) { this.publish(); } });
      session.rolling = result.metadata?.nxSessionState ?? session.rolling;
      session.responseMetadata = result.metadata;
      if (result.errorDetails && assistant.status !== 'cancelled') { assistant.status = 'failed'; }
      if (assistant.status === 'running') { assistant.status = source.token.isCancellationRequested ? 'cancelled' : 'completed'; }
      session.turn.status = assistant.status!;
    } catch (error) {
      if (!assistant) this.contextNotice = error instanceof ContextError || error instanceof ReferenceValidationError ? error.message : 'Send could not start. Check connection, model and workspace context; remove or reselect unavailable items and retry.';
      if (assistant && session.turn) {
        assistant.status = source.token.isCancellationRequested ? 'cancelled' : 'failed'; session.turn.status = assistant.status;
        session.turn.notice = assistant.status === 'failed' ? 'The turn failed. Check connection and model setup, then retry.' : 'Cancelled';
      }
    } finally {
      this.touching();
      if (session.turn) for (const tool of session.turn.tools) {
        if (tool.state === 'running') tool.state = session.turn.status === 'cancelled' ? 'cancelled' : 'failed';
      }
    }
  }
  private executionLabel(turn: ChatTurn): string {
    const transition = turn.escalation;
    return [turn.mode === 'manual' ? 'Manual' : transition?.completed ? `↑ ${transition.from} → ${transition.to}` : turn.route,
      turn.modelName || turn.modelId, turn.effort && turn.effort !== 'default' ? turn.effort : undefined,
      transition && !transition.completed ? 'Escalation unavailable' : undefined].filter(Boolean).join(' · ');
  }
  private projectTurn(turn: ChatTurn): ChatTurn {
    return { providerId: turn.providerId, providerLabel: turn.providerLabel, messageId: turn.messageId, mode: turn.mode, status: turn.status, route: turn.route, modelId: turn.modelId, modelName: turn.modelName,
      effort: turn.effort, escalation: turn.escalation ? { from: turn.escalation.from, to: turn.escalation.to, completed: turn.escalation.completed } : undefined, notice: turn.notice,
      tools: turn.tools.map(tool => ({ id: tool.id, label: tool.label, target: tool.target, lineRange: tool.lineRange, command: tool.command, state: tool.state, durationMs: tool.durationMs })),
      changedFiles: [...turn.changedFiles] };
  }
  private event(session: SidebarChatSession, assistant: SidebarChatSession['messages'][number], event: NxRuntimeEvent): void {
    const turn = session.turn!;
    if (event.type === 'textDelta' && (!event.source || event.source === 'assistant')) { assistant.text += event.text; }
    else if (event.type === 'route') { turn.route = event.route; }
    else if (event.type === 'model') { turn.modelId = event.modelId; turn.modelName = this.providers.state(session.providerId).models.find(model => model.id === event.modelId)?.name; turn.effort = event.effort; }
    else if (event.type === 'escalation') { turn.escalation = { from: turn.escalation?.from ?? event.from, to: event.to, completed: event.completed }; }
    else if (event.type === 'completion') {
      assistant.status = ['completed', 'partial', 'cancelled', 'failed'].includes(event.status) ? event.status as typeof turn.status : 'failed';
      turn.status = assistant.status; turn.route = event.finalRoute;
      if (assistant.status === 'failed' || assistant.status === 'partial') { turn.notice = assistant.status === 'failed' ? 'Runtime or tool failure. Check connection and model setup, then retry.' : 'Partially completed. Review the result before continuing.'; }
    } else if (event.type === 'cancellation') { assistant.status = 'cancelled'; turn.status = 'cancelled'; turn.notice = 'Cancelled'; }
    else if (event.type === 'error') { assistant.status = 'failed'; turn.status = 'failed'; turn.notice = 'The turn failed. Check connection and model setup, then retry.'; }
    else if (event.type === 'toolStart' || event.type === 'toolResult') {
      // Re-allowlist the shared normalized seam; no raw name, input, output or summary in snapshots.
      const meta = event.activity;
      const base = toolActivity(event.tool, {});
      let tool = event.type === 'toolResult' ? [...turn.tools].reverse().find(item => item.state === 'running') : undefined;
      if (!tool) { tool = { id: newId(), label: base.label, state: 'running' }; turn.tools.push(tool); }
      if (meta) {
        tool.target = workspaceIdentity(meta.target);
        if (meta.lineRange && /^\d{1,7}–\d{1,7}$/.test(meta.lineRange)) tool.lineRange = meta.lineRange;
        // Fixed command vocabulary only, even if a future emitter supplies a malformed seam.
        const command = verificationLabel(meta.command);
        if (command) {
          tool.command = command; tool.label = command;
        }
      }
      if (event.type === 'toolResult') {
        tool.state = ['success', 'failed', 'cancelled', 'rejected'].includes(event.outcome) ? event.outcome as typeof tool.state : 'failed';
        if (Number.isFinite(event.durationMs) && event.durationMs! >= 0) tool.durationMs = Math.round(event.durationMs!);
        if (event.outcome === 'success' && ['nx_create_file', 'nx_edit_file', 'nx_move_file', 'nx_copy_file'].includes(event.tool)) {
          for (const target of event.changedTargets ?? []) { const identity = workspaceIdentity(target); if (identity && !turn.changedFiles.includes(identity)) turn.changedFiles.push(identity); }
        }
      }
    }
  }
  private segment(providerId: string, startIndex: number, mode: 'fresh' | 'selected', carryCount = 0) {
    return { id: newId(), sessionId: this.session!.sessionId, providerId, providerLabel: this.providers.state(providerId).label,
      startIndex, contextCarryMode: mode, createdAt: new Date().toISOString(), carryCount };
  }
  /** Candidates are host-owned grants/safe descriptors. Merely opening this list performs no source reads. */
  private carryCandidates(): DraftReference[] {
    const result = this.draftContext.map(ref => ({ ...ref, descriptor: { ...ref.descriptor } }));
    if (result.length >= referenceLimits.count) return result;
    const seen = new Set(result.map(ref => JSON.stringify(ref.descriptor)));
    for (const message of [...(this.session?.messages ?? [])].reverse()) {
      for (const raw of message.references ?? []) {
        const descriptor = referenceDescriptor(raw);
        if (!descriptor || descriptor.scope || !['file', 'diagnostics', 'git_diff'].includes(descriptor.kind)) continue;
        const key = JSON.stringify(descriptor); if (seen.has(key)) continue; seen.add(key);
        result.push({ id: newId(), descriptor, provenance: descriptor.kind === 'file' ? 'current_file' : descriptor.kind as 'diagnostics' | 'git_diff' });
        if (result.length >= referenceLimits.count) return result;
      }
    }
    return result;
  }
  async chooseProvider(): Promise<boolean> {
    await this.initialize(); this.stop(); await this.active?.done; await this.save();
    if (this.persistenceNotice || !this.session) return false;
    await this.refreshProviders();
    const session = this.session;
    const destination = await this.picker.pick(this.providers.summaries().filter(item => item.selectable).map(item => ({ label: item.label, id: item.id })),
      { title: 'Choose provider', placeHolder: 'Explicitly select the provider for this chat' });
    if (!destination || destination.id === session.providerId) return true;
    const choice = await this.picker.pick([
      { label: 'Continue fresh', description: 'Do not send previous provider conversation.', mode: 'fresh' as const },
      { label: 'Carry selected context', description: 'Send only context you explicitly choose.', mode: 'selected' as const },
      { label: 'Start new chat', description: 'Create a separate chat without transcript or context.', mode: 'new' as const }
    ], { title: `Switch provider: ${this.providers.state(session.providerId).label} → ${destination.label}`,
      placeHolder: 'Previous history stays local. Draft text is preserved; unsent attachments go to the selected provider.' });
    if (!choice || session !== this.session) return false;
    let selected: DraftReference[] = [];
    if (choice.mode === 'selected') {
      const candidates = this.carryCandidates();
      const picked = await this.picker.many(candidates.map(ref => ({ label: referenceLabel(ref.descriptor), ref })),
        { title: `Carry context to ${destination.label}`, canPickMany: true, placeHolder: `Selected context will be sent to ${destination.label}. Choose exactly what to carry.` });
      if (!picked?.length) return false;
      selected = picked.map(item => item.ref);
      const confirmed = await this.picker.confirm(`Selected context will be sent to ${destination.label}: ${selected.map(ref => referenceLabel(ref.descriptor)).join(', ')}. Unselected draft attachments will be removed; draft text stays.`);
      if (!confirmed) return false;
    }
    if (choice.mode === 'new') { const originSession = session.sessionId; await this.newChat(destination.id, originSession); this.publish(); return true; }
    return this.switchProvider(destination.id, choice.mode, selected);
  }
  /** Host-only commit after explicit native choice; never accepts paths/content from the Webview. */
  private async switchProvider(providerId: string, mode: 'fresh' | 'selected', selected: DraftReference[]): Promise<boolean> {
    const session = this.session; if (!session || this.active || providerId === session.providerId) return false;
    await this.refreshProviders();
    if (!this.providers.summaries().some(item => item.id === providerId && item.selectable)) return false;
    const origin = { originProviderId: session.providerId, originProviderLabel: this.providers.state(session.providerId).label };
    const drafts = mode === 'selected' ? selected.map(ref => ({ ...ref, id: newId() })) : [...this.draftContext];
    if (drafts.length > referenceLimits.count) { this.contextNotice = 'Attach at most 8 context items.'; this.publish(); return false; }
    const segment = this.segment(providerId, session.messages.length, mode, selected.length);
    const next: SidebarChatSession = { ...session, providerId, segmentId: segment.id, segments: [...(session.segments ?? []), segment],
      execution: { autoOn: this.providers.state(providerId).auto }, rolling: undefined, responseMetadata: undefined, updatedAt: new Date().toISOString() };
    // Durable session replacement precedes activation; a failed save leaves the current segment intact.
    this.committing = true;
    try { await this.store?.save(next); } catch { this.persistenceNotice = 'Chat could not be saved locally. Check local storage and retry before reloading.'; this.publish(); return false; }
    finally { this.committing = false; }
    this.session = next; this.executions.bind(next.sessionId, providerId); this.executions.restore(next.sessionId, next.execution, next.execution.autoOn);
    this.draftContext = drafts.map(ref => ({ ...ref, crossProvider: origin })); this.contextNotice = undefined;
    this.carryNeedsReselection = false;
    this.reconcile(); this.publish(); return true;
  }
  stop(): boolean { if (!this.active) { return false; } this.active.source.cancel(); this.publish(); return true; }
  dispose(): void { clearTimeout(this.timer); void this.save(); this.disposed = true; this.active?.source.cancel(); if (this.session) { this.executions.delete(this.session.sessionId); } }
}

function configLabel(providers: SidebarProviders, id: string): string { return providers.state(id).label; }
