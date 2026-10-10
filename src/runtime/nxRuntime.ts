import * as vscode from 'vscode';
import { NxReference, validateReferences, routingReferences } from './references';
import { Route } from '../route';
import { collectTaskContext, decideRoute, parseManualOverride, fallbackResult, TaskContext, RouteDecision, Intent } from '../router';
import { evaluateRiskFloor, maxRoute, detectCriticalUnknowns } from '../guardrails';
import { Enricher, createVsCodeEnricher } from '../enrichment';
import { Telemetry, newId, estimateCost, ModelRecord } from '../telemetry';
import { NxSessionState, updateSessionState } from '../sessionState';
import { runWorkerLoop, WorkerResult } from '../worker/workerLoop';
import type { ToolActivityInfo } from '../worker/toolActivity';
import { routeLabel, workerOutcome } from '../presentation';
import { NxModelSelection, NxProviderManager, NxProviderProfile } from './providers';

export type NxExecutionSelection = { mode: 'auto'; providerId: string } | { mode: 'manual'; providerId: string; model: NxModelSelection };
export interface NxUserTurn {
  conversation?: readonly { role: 'user' | 'assistant'; text: string }[];
  sessionId?: string; segmentId?: string; text: string; references: NxReference[];
  previous?: NxSessionState; command?: string; execution: NxExecutionSelection; profile: NxProviderProfile;
  providerSwitch?: { manual: boolean; carryMode: 'fresh' | 'selected' };
  previousProviderId?: string; providerBoundary?: { explicit: true; fromProviderId: string };
  token: vscode.CancellationToken; toolInvocationToken?: vscode.LanguageModelToolInvocationOptions<object>['toolInvocationToken']; enrich?: Enricher;
}
export type NxRuntimeEvent =
  | { type: 'route'; route: Route }
  | { type: 'model'; providerId: string; modelId: string; effort?: string }
  | { type: 'textDelta'; text: string; source?: 'assistant' | 'status' | 'error' }
  | { type: 'toolStart'; tool: string; activity?: ToolActivityInfo }
  | { type: 'toolResult'; tool: string; outcome: string; activity?: ToolActivityInfo; durationMs?: number; changedTargets?: string[] }
  | { type: 'escalation'; from: Route; to: Route; completed: boolean }
  | { type: 'completion'; status: string; finalRoute: Route }
  | { type: 'cancellation' }
  | { type: 'error'; message: string };
export interface NxTurnResult { metadata?: { nxSessionState?: NxSessionState; nxExecution?: { sessionId: string; autoOn: boolean; manual?: NxModelSelection }; nxTurn?: {
  providerId: string; segmentId: string; modelId?: string; effort?: string; routingMode: 'auto' | 'manual';
  initialRoute?: Route; actualRoute?: Route
} }; errorDetails?: { message: string } }

/** Manual choice skips the model router while retaining the deterministic risk floor. */
export function manualDecision(context: TaskContext): RouteDecision {
  const result = fallbackResult(context);
  const unknowns = detectCriticalUnknowns(context, result);
  const riskGate = evaluateRiskFloor(context, result, {}, unknowns);
  const route = maxRoute('MEDIUM', riskGate.minimumRoute);
  return { result, initialResult: result, initialRoute: route, finalRoute: route, retryCount: 0,
    routerRequestCount: 0, fallback: false, criticalUnknowns: unknowns, enrichmentPerformed: false, riskGate };
}
export class NxRuntime {
  constructor(private readonly telemetry: Telemetry, private readonly providers: NxProviderManager,
    private readonly onSession: (sessionId: string) => void = () => {}) {}
  async run(turn: NxUserTurn, emit: (event: NxRuntimeEvent) => void): Promise<NxTurnResult> {
    validateReferences(turn.references);
    const switching = !!turn.previousProviderId && turn.previousProviderId !== turn.execution.providerId;
    if (switching && (!turn.providerBoundary?.explicit || turn.providerBoundary.fromProviderId !== turn.previousProviderId)) {
      throw new Error('Provider switching requires an explicit provider boundary.');
    }
    const segmentId = switching ? newId() : turn.segmentId ?? newId();
    const provider = this.providers.require(turn.execution.providerId);
    const currentProfile = provider.profile?.() ?? turn.profile;
    const effective = switching ? { ...turn, profile: currentProfile, previous: undefined, conversation: undefined, segmentId } : { ...turn, profile: currentProfile, segmentId };
    const result = await this.execute(effective, emit);
    let selection: NxModelSelection | undefined;
    try { selection = turn.execution.mode === 'manual' ? turn.execution.model : currentProfile.auto.tiers[result.actualRoute ?? 'MEDIUM']; }
    catch { /* Invalid mapping was reported by the worker. */ }
    result.metadata = { ...result.metadata, nxTurn: { providerId: turn.execution.providerId, segmentId,
      modelId: selection?.modelId, effort: selection?.effort, routingMode: turn.execution.mode,
      initialRoute: result.initialRoute, actualRoute: result.actualRoute } };
    return result;
  }
  private async execute(turn: NxUserTurn, emit: (event: NxRuntimeEvent) => void): Promise<NxTurnResult & { initialRoute?: Route; actualRoute?: Route }> {
    const { token } = turn;
    const previous = turn.previous;
    const request = turn;
    const stream = { markdown: (text: string, source: 'assistant' | 'status' | 'error' = 'assistant') => emit({ type: 'textDelta', text, source }) };
    const started = Date.now();
    const sessionId = turn.sessionId ?? previous?.sessionId ?? newId();
    const turnId = newId();
    this.onSession(sessionId);
    let route: Route = 'MEDIUM';
    let initialFinalRoute: Route = 'MEDIUM';
    const escalationEvents: Array<{ from: Route; to: Route; rule_ids: string[]; completed: boolean }> = [];
    let initialRoute: Route = 'MEDIUM';
    let enrichedRoute: Route | undefined;
    let riskFloor: Route = 'LOW';
    let riskGateRules: string[] = [];
    let criticalUnknownCount = 0;
    let enrichmentPerformed = false;
    let enrichmentFailure: string | undefined;
    let routerRequestCount = 0;
    let confidence = 0;
    let retryCount = 0;
    let manualOverride: Route | undefined;
    let parsedTask = turn.text;
    let normalizedTask: string | undefined;
    let intent: Intent | undefined;
    let activeTarget: string | undefined;
    let workerResult: WorkerResult | undefined;
    let status: 'completed' | 'partial' | 'failed' | 'cancelled' = 'failed';
    let autoAvailableAtExecution: boolean | undefined;
    let mappingValidationFailure: 'unconfigured' | 'unavailable' | 'connection' | 'manual_model_unavailable' | undefined;
    const recordRequest = async (model: vscode.LanguageModelChat, role: 'router' | 'worker', effort: string | undefined,
      messages: vscode.LanguageModelChatMessage[], run: () => Promise<string>, modelRoute?: Route): Promise<string> => {
      const at = Date.now();
      if (role === 'router') routerRequestCount++;
      let input: number | undefined; let output: number | undefined; let response = ''; let success = false;
      try {
        try { input = (await Promise.all(messages.map(message => model.countTokens(message, token)))).reduce((a, b) => a + b, 0); } catch { /* Token count may be unavailable. */ }
        response = await run();
        try { output = await model.countTokens(response, token); } catch { /* Token count may be unavailable. */ }
        success = true;
        return response;
      } finally {
        const record: ModelRecord = { session_id: sessionId, turn_id: turnId, request_id: newId(), role,
          provider: model.vendor, model: model.id, effort, route: modelRoute, observed_input_tokens: input, observed_output_tokens: output,
          duration_ms: Date.now() - at, success, estimated_api_equivalent_cost_usd: estimateCost(model.id, input, output), at: new Date().toISOString() };
        await this.telemetry.recordModel(record);
      }
    };
    try {
      await this.telemetry.startSession(sessionId);
      const parsed = turn.execution.mode === 'auto' ? parseManualOverride(request.text, turn.command) : { task: turn.text, override: undefined };
      parsedTask = parsed.task;
      manualOverride = parsed.override;
      const taskContext = collectTaskContext(parsed.task, previous);
      taskContext.references = routingReferences(turn.references);
      const attachedTarget = turn.references.find(ref => (ref.descriptor.kind === 'file' || ref.descriptor.kind === 'selection') && !ref.descriptor.scope)?.descriptor;
      if (attachedTarget && 'path' in attachedTarget) taskContext.activeTarget = attachedTarget.path;
      activeTarget = taskContext.activeTarget;
      const profile = turn.profile;
      if (profile.providerId !== turn.execution.providerId) { throw new Error('Provider profile does not match the selected provider.'); }
      const provider = this.providers.require(profile.providerId);
      const availability = turn.execution.mode === 'auto' ? await provider.autoAvailability?.() : undefined;
      autoAvailableAtExecution = availability?.available;
      if (turn.execution.mode === 'auto' && availability && !availability.available) {
        const invalid = availability.mappings[availability.missingOrUnavailable[0]];
        mappingValidationFailure = (await provider.connectionStatus()) !== 'connected' ? 'connection' :
          invalid.validity === 'unconfigured' ? 'unconfigured' : 'unavailable';
        throw new Error(`Auto routing is unavailable: ${availability.missingOrUnavailable.join(', ')} model mapping needs attention. Run NX Router: Configure OpenAI Models.`);
      }
      if (turn.execution.mode === 'manual' && !(await provider.resolveModel(turn.execution.model))) {
        mappingValidationFailure = 'manual_model_unavailable';
        throw new Error(`Manual model "${turn.execution.model.modelId}" is unavailable for the active provider/account.`);
      }
      const decision = turn.execution.mode === 'auto' ? await decideRoute(taskContext, manualOverride, async prompt => {
        const selection = profile.auto.router;
        const model = await provider.resolveModel(selection);
        if (!model) { throw new Error(`NX router ${selection.modelId} is unavailable.`); }
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        return recordRequest(model, 'router', selection.effort, messages, async () => {
          const response = await model.sendRequest(messages, { modelOptions: { reasoningEffort: selection.effort } }, token);
          let body = ''; for await (const chunk of response.text) { body += chunk; }
          return body;
        });
      }, { enrich: turn.enrich ?? (turn.references.some(ref => ref.descriptor.kind === 'file' || ref.descriptor.kind === 'selection') ? createVsCodeEnricher() : undefined), cancellation: token }) : manualDecision(taskContext);
      if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
      route = decision.finalRoute; initialFinalRoute = route; initialRoute = decision.initialRoute;
      enrichedRoute = decision.enrichedRoute; riskFloor = decision.riskGate.minimumRoute;
      riskGateRules = decision.riskGate.triggeredRules; criticalUnknownCount = decision.criticalUnknowns.length;
      enrichmentPerformed = decision.enrichmentPerformed; enrichmentFailure = decision.enrichmentFailure;
      console.log(`[NX Router] initial=${initialRoute} enriched=${enrichedRoute ?? '-'} critical=${criticalUnknownCount} enrichment=${enrichmentPerformed ? (enrichmentFailure ?? 'ok') : 'none'} floor=${riskFloor} rules=${riskGateRules.join(',')} manual=${manualOverride ?? '-'} final=${route}`);
      confidence = decision.result.confidence; retryCount = decision.retryCount;
      normalizedTask = decision.result.normalized_task;
      intent = decision.result.intent;
      emit({ type: 'route', route });
      stream.markdown(`${routeLabel(manualOverride ?? route, route, manualOverride, decision.riskGate.reasons[0])}${decision.fallback ? ' · router fallback' : ''}\n\n`, 'status');
      const attachments = turn.references;
      workerResult = await runWorkerLoop({ route: decision.finalRoute, task: taskContext, normalizedTask: normalizedTask ?? parsed.task,
        sessionState: previous, conversation: turn.conversation, references: attachments, token, toolInvocationToken: turn.toolInvocationToken,
        selectModel: tier => provider.resolveModel(turn.execution.mode === 'manual' ? turn.execution.model : profile.auto.tiers[tier]),
        modelSelection: tier => turn.execution.mode === 'manual' ? turn.execution.model : profile.auto.tiers[tier],
        allowEscalation: turn.execution.mode === 'auto',
        fixtureTools: turn.execution.mode === 'auto' && provider.id === 'nx-spike',
        onToolStart: (tool, activity) => emit({ type: 'toolStart', tool, activity }),
        stream: text => stream.markdown(text),
        onModelRequest: (model, messages, run, workerRoute) => {
          const selection = turn.execution.mode === 'manual' ? turn.execution.model : profile.auto.tiers[workerRoute];
          emit({ type: 'model', providerId: provider.id, modelId: selection.modelId, effort: selection.effort });
          return recordRequest(model, 'worker', selection.effort, messages, run, workerRoute);
        },
        onEscalation: async (change, completed) => {
          escalationEvents.push({ from: change.fromRoute, to: change.toRoute!, rule_ids: change.ruleIds.slice(0, 4), completed });
          emit({ type: 'escalation', from: change.fromRoute, to: change.toRoute!, completed });
          if (completed) { stream.markdown(`\n\nNX · ${change.fromRoute} → ${change.toRoute}: ${change.reasons.join(', ')}.\n\n`, 'status'); }
        },
        onToolEvent: event => { emit({ type: 'toolResult', tool: event.name, outcome: event.outcome, activity: event.activity, durationMs: event.durationMs, changedTargets: event.changedTargets }); return this.telemetry.recordTool({ session_id: sessionId, turn_id: turnId, tool: event.name,
          risk_class: event.risk, outcome: event.outcome, success: event.outcome === 'success',
          policy_rule_ids: event.policyRuleIds, requested_kind: event.requestedKind, requested_route: event.requestedRoute,
          escalation_accepted: event.escalationAccepted, duration_ms: event.durationMs, at: new Date().toISOString() }); } });
      route = workerResult.finalRoute;
      if (workerResult.status !== 'cancelled') {
        let modelId: string | undefined;
        try { if (!['model_unavailable', 'model_error', 'escalation_unavailable'].includes(workerResult.stopReason)) { modelId = (turn.execution.mode === 'manual' ? turn.execution.model : profile.auto.tiers[route]).modelId; } } catch { /* Invalid mapping is explained by worker outcome. */ }
        stream.markdown(`\n\n${workerOutcome(workerResult, modelId)}`, 'status');
      }
      status = workerResult.status;
      emit({ type: 'completion', status, finalRoute: route });
      const stable = (workerResult.stopReason === 'model_unavailable' || workerResult.stopReason === 'model_error') && !workerResult.escalations.length || workerResult.status === 'cancelled';
      const knownOutcome = workerResult.unresolved.length && !workerResult.changedTargets.length ? `Worker issue: ${workerResult.stopReason}; ${workerResult.unresolved.at(-1)}` :
        workerResult.verification.length ? workerResult.verification.at(-1) :
        workerResult.changedTargets.length ? (workerResult.status === 'partial' ? 'Change applied; verification not completed' : 'Change applied') :
        workerResult.stopReason === 'completed' ? 'Worker response completed; no verification recorded' : `Worker stopped: ${workerResult.stopReason}`;
      return { initialRoute: initialFinalRoute, actualRoute: route, metadata: { nxSessionState: stable ? previous : updateSessionState(previous, { sessionId, prompt: parsedTask, normalizedTask, intent, route,
        activeTarget: workerResult.changedTargets[0] ?? activeTarget, action: workerResult.escalations.length ?
          `${workerResult.escalationCompleted ? 'Escalated' : 'Escalation required'} ${workerResult.escalations.at(-1)?.fromRoute} to ${workerResult.escalations.at(-1)?.toRoute}` : workerResult.actions.at(-1), outcome: knownOutcome,
        error: workerResult.unresolved.at(-1), pendingNextStep: workerResult.status === 'partial' ? workerResult.unresolved.at(-1) ?? 'Continue verification' : undefined,
        status: workerResult.status === 'failed' ? 'failed' : 'completed' }) },
        ...(workerResult.status === 'failed' ? { errorDetails: { message: workerResult.summary } } : {}) };
    } catch (error) {
      if (token.isCancellationRequested || error instanceof vscode.CancellationError) { status = 'cancelled'; emit({ type: 'cancellation' }); return { initialRoute: initialFinalRoute, actualRoute: route, metadata: { nxSessionState: previous } }; }
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: 'error', message });
      stream.markdown(`NX Router stopped: ${message}`, 'error');
      return { initialRoute: initialFinalRoute, actualRoute: route, errorDetails: { message: 'The NX turn did not complete. See the response for details.' },
        metadata: { nxSessionState: updateSessionState(previous, { sessionId, prompt: parsedTask, normalizedTask, intent, route,
          activeTarget, action: normalizedTask, outcome: 'Turn failed', error: message, status: 'failed' }) } };
    } finally {
      let recordedSelection: NxModelSelection | undefined;
      try { recordedSelection = turn.execution.mode === 'manual' ? turn.execution.model : turn.profile.auto.tiers[route]; }
      catch { /* Preserve the original model mapping failure. */ }
      await this.telemetry.recordTurn({ provider_id: turn.execution.providerId, provider_segment_id: turn.segmentId, routing_mode: turn.execution.mode, model_id: recordedSelection?.modelId, effort: recordedSelection?.effort,
        manual_provider_switch: turn.providerSwitch?.manual ?? (turn.providerBoundary?.explicit === true), context_carry_mode: turn.providerSwitch?.carryMode ?? 'fresh',
        auto_available_at_execution: autoAvailableAtExecution, mapping_validation_failure: mappingValidationFailure,
        session_id: sessionId, turn_id: turnId, initial_route: initialRoute, initial_final_route: initialFinalRoute, final_route: route,
        final_worker_route: route, escalation_count: escalationEvents.length, escalated: escalationEvents.length > 0,
        escalation_from: escalationEvents[0]?.from, escalation_to: escalationEvents.at(-1)?.to,
        escalation_rule_ids: [...new Set(escalationEvents.flatMap(event => event.rule_ids))],
        escalation_completed: escalationEvents.length ? escalationEvents.every(event => event.completed) : true,
        escalation_events: escalationEvents.slice(0, 2),
        confidence, retry_count: retryCount, manual_override: manualOverride, enriched_route: enrichedRoute,
        critical_unknown_count: criticalUnknownCount, enrichment_performed: enrichmentPerformed, enrichment_failure: enrichmentFailure,
        risk_floor: riskFloor, risk_gate_rules: riskGateRules, router_request_count: routerRequestCount,
        worker_iterations: workerResult?.iterations, worker_model_requests: workerResult?.iterations, worker_tool_calls: workerResult?.toolCalls,
        worker_stop_reason: workerResult?.stopReason,
        duration_ms: Date.now() - started, status, at: new Date().toISOString() });
    }
  }
}
