import { Route } from './route';
import { WorkerResult } from './worker/workerLoop';

export function routeLabel(initial: Route, final: Route, manual?: Route, riskReason?: string): string {
  const path = initial === final ? final : `${initial} → ${final}`;
  const upgrade = manual && manual !== final ? ` · Requested ${manual}; safety upgrade: ${riskReason ?? 'risk floor'}` : '';
  return `NX · ${path}${upgrade}`;
}
export function workerOutcome(result: WorkerResult, modelId?: string): string {
  if (result.status === 'cancelled') { return ''; }
  const route = result.escalations.length ? `${result.escalations[0].fromRoute} → ${result.finalRoute}` : result.finalRoute;
  const lines = [`Route: ${route}${modelId ? ` · Worker: ${modelId}` : ''}`];
  if (result.consultedInstructions?.length) { lines.push(`Repository instructions consulted: ${result.consultedInstructions.join(', ')}`); }
  if (result.changedTargets.length) { lines.push(`Changed: ${[...new Set(result.changedTargets)].join(', ')}`); }
  if (result.verification.length) { lines.push(`Verified: ${result.verification.join('; ')}`); }
  if (result.changedTargets.length && !result.verification.length) { lines.push('Not verified: no successful verification was recorded.'); }
  if (result.unresolved.length) { lines.push(`Remaining: ${result.unresolved.join('; ')}`); }
  const errors: Partial<Record<WorkerResult['stopReason'], string>> = {
    model_unavailable: `NX could not start the ${result.finalRoute} worker because its configured model is unavailable. Check nxRouter.models.${result.finalRoute.toLowerCase()}.`,
    escalation_unavailable: `NX could not continue at ${result.finalRoute} because the required model is unavailable. Check nxRouter.models.${result.finalRoute.toLowerCase()}.`,
    tool_rejected: 'The requested tool action was not applied.',
    max_iterations: 'NX stopped because the worker iteration limit was reached.',
    model_error: 'NX stopped because the worker model request failed.',
    tool_error: 'NX stopped because a tool failed.'
  };
  if (result.stopReason !== 'completed') { lines.push(errors[result.stopReason] ?? `NX stopped: ${result.stopReason}.`); }
  return lines.join('  \n');
}
