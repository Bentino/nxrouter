import { Route } from '../route';

export type EvidenceKind = 'low_complexity_invalidated' | 'architecture_invalidated' | 'security_boundary' | 'existing_data_mutation' |
  'production_mutation' | 'consequential_write' | 'destructive_operation' | 'broad_contract' | 'conflicting_evidence';
export interface EscalationEvidence {
  kind: EvidenceKind; summary: string; source: 'tool_result' | 'worker_observation' | 'runtime_error' | 'repository_evidence';
  provenance: 'inspected_content' | 'documentation_text' | 'structured_operation' | 'trusted_runtime' | 'worker_observation';
  corroborated?: true;
  targetRoute: 'MEDIUM' | 'HIGH';
}
export interface ObservationFact { provenance: EscalationEvidence['provenance']; text: string }
export interface EscalationDecision { escalate: boolean; fromRoute: Route; toRoute?: 'MEDIUM' | 'HIGH'; ruleIds: string[]; reasons: string[] }
export interface EscalationHandoff {
  originalTask: string; normalizedTask: string; fromRoute: Route; toRoute: 'MEDIUM' | 'HIGH';
  evidence: EscalationEvidence[]; actionsCompleted: string[]; changedTargets: string[];
  verificationResults: string[]; unresolved: string[]; relevantToolFacts: string[];
}
const highRules: Record<Exclude<EvidenceKind, 'low_complexity_invalidated'>, string> = {
  architecture_invalidated: 'RUNTIME_ARCHITECTURE_INVALIDATED', security_boundary: 'RUNTIME_SECURITY_BOUNDARY',
  existing_data_mutation: 'RUNTIME_EXISTING_DATA_MUTATION', production_mutation: 'RUNTIME_PRODUCTION_MUTATION',
  consequential_write: 'RUNTIME_CONSEQUENTIAL_WRITE', destructive_operation: 'RUNTIME_DESTRUCTIVE_OPERATION',
  broad_contract: 'RUNTIME_BROAD_CONTRACT', conflicting_evidence: 'RUNTIME_CONFLICTING_EVIDENCE'
};
const bounded = (value: string, length: number) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length);
const unique = (items: string[], count: number, length: number) => [...new Set(items.map(item => bounded(item, length)).filter(Boolean))].slice(-count);
export function validateEvidence(value: unknown): EscalationEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
  const item = value as Record<string, unknown>;
  if (typeof item.kind !== 'string' || !(item.kind === 'low_complexity_invalidated' || item.kind in highRules) ||
      typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 300 ||
      !['tool_result', 'worker_observation', 'runtime_error', 'repository_evidence'].includes(String(item.source)) ||
      !['inspected_content', 'documentation_text', 'structured_operation', 'trusted_runtime', 'worker_observation'].includes(String(item.provenance)) ||
      !['MEDIUM', 'HIGH'].includes(String(item.targetRoute))) { return undefined; }
  return { kind: item.kind as EvidenceKind, summary: bounded(item.summary, 300), source: item.source as EscalationEvidence['source'],
    provenance: item.provenance as EscalationEvidence['provenance'], targetRoute: item.targetRoute as 'MEDIUM' | 'HIGH' };
}
const operationKinds = new Set<EvidenceKind>(['production_mutation', 'destructive_operation', 'consequential_write']);
export function sufficientEvidence(item: EscalationEvidence): boolean {
  if (item.source === 'worker_observation') { return item.provenance === 'worker_observation' && item.corroborated === true; }
  if (item.provenance === 'inspected_content') { return !operationKinds.has(item.kind); }
  return item.provenance === 'structured_operation' || item.provenance === 'trusted_runtime';
}
export function evaluateEscalation(currentRoute: Route, evidence: EscalationEvidence[], count = 0): EscalationDecision {
  const accepted = evidence.filter(sufficientEvidence);
  const rules = [...new Set(accepted.flatMap(item => item.kind === 'low_complexity_invalidated' ? ['LOW_COMPLEXITY_INVALIDATED'] : [highRules[item.kind]]))];
  const toRoute = accepted.some(item => item.kind !== 'low_complexity_invalidated') ? 'HIGH' : accepted.length ? 'MEDIUM' : undefined;
  const escalate = count < 2 && currentRoute !== 'HIGH' && !!toRoute && (currentRoute === 'LOW' || toRoute === 'HIGH');
  return { escalate, fromRoute: currentRoute, ...(escalate ? { toRoute } : {}), ruleIds: rules, reasons: accepted.map(item => item.kind).slice(0, 4) };
}
export function buildHandoff(task: string, normalized: string, fromRoute: Route, toRoute: 'MEDIUM' | 'HIGH',
  evidence: EscalationEvidence[], actions: string[], targets: string[], verification: string[], unresolved: string[], facts: string[]): EscalationHandoff {
  return { originalTask: bounded(task, 4000), normalizedTask: bounded(normalized, 1000), fromRoute, toRoute,
    evidence: evidence.slice(-4).map(item => ({ ...item, summary: bounded(item.summary, 240) })),
    actionsCompleted: unique(actions, 8, 160), changedTargets: unique(targets, 8, 200),
    verificationResults: unique(verification, 6, 160), unresolved: unique(unresolved, 6, 160),
    relevantToolFacts: unique(facts, 8, 240) };
}
// Only explicit, structured metadata from a completed production tool can trigger rescue without a worker observation.
export function toolEvidence(data: unknown, toolName?: string): EscalationEvidence[] {
  if (!data || typeof data !== 'object') { return []; }
  const raw = (data as { escalationEvidence?: unknown }).escalationEvidence;
  return (Array.isArray(raw) ? raw : []).slice(0, 4).map(validateEvidence).filter((item): item is EscalationEvidence =>
    !!item && item.source === 'tool_result' && sufficientEvidence(item) &&
    (!['nx_read', 'nx_search'].includes(toolName ?? '') || item.provenance === 'inspected_content'));
}
export const isDocumentationPath = (path: string) => /(?:^|\/)(?:README|AGENTS)\.md$/i.test(path) || /\.md$/i.test(path);
export function extractRuntimeEvidence(content: string, path?: string): EscalationEvidence[] {
  if (path && isDocumentationPath(path)) { return []; }
  const text = content.slice(0, 8000);
  const found: EscalationEvidence[] = [];
  const add = (kind: EvidenceKind, summary: string) => found.push({ kind, summary, source: 'tool_result', provenance: 'inspected_content', targetRoute: kind === 'low_complexity_invalidated' ? 'MEDIUM' : 'HIGH' });
  if (/\b(?:views bulk operations|vbo)\b/i.test(text) && /\bdraggableviews\b/i.test(text) &&
      /\b(?:sort\w*|order\w*)\b/i.test(text) && /\b(?:both|competing|conflict|override|interact)\b/i.test(text)) {
    add('architecture_invalidated', 'Views Bulk Operations and DraggableViews both participate in ordering.');
  }
  if (/\bserver[- ]side\s+(?:authorization|access control|permission rule)\b/i.test(text)) {
    add('security_boundary', 'Server-side authorization or access rules control the behavior.');
  }
  if (/\b(?:field|storage|schema)\b.{0,100}\b(?:already contains|contains existing|has existing|populated with)\s+(?:records|rows|data)\b/i.test(text)) {
    add('existing_data_mutation', 'The affected field or storage already contains records.');
  }
  return found.slice(0, 3);
}
// Operation claims require operational facts; inspected prose can corroborate only discovery rules.
export function corroborateObservation(evidence: EscalationEvidence, facts: ObservationFact[]): boolean {
  if (evidence.source !== 'worker_observation' || !facts.length) { return false; }
  const eligible = facts.filter(fact => fact.provenance !== 'documentation_text' &&
    (!operationKinds.has(evidence.kind) || fact.provenance === 'structured_operation' || fact.provenance === 'trusted_runtime'));
  const body = eligible.map(fact => fact.text).join(' ').toLowerCase();
  const match: Record<EvidenceKind, RegExp> = {
    low_complexity_invalidated: /(?:multiple|several|cross[- ]file|depends on|debugg|shared)/,
    architecture_invalidated: /(?:draggableviews.*(?:views bulk operations|vbo)|(?:views bulk operations|vbo).*draggableviews|competing.*(?:sort|order)|two.*(?:sort|order).*mechanism|assumption.*invalid)/,
    security_boundary: /(?:server[- ]side.*(?:auth|access|permission)|(?:auth|access|permission).*(?:rule|handler|boundary|semantics))/,
    existing_data_mutation: /(?:existing|populated|already).*(?:records|rows|data)|(?:records|rows).*(?:exist|present)/,
    production_mutation: /(?:production|prod\b).*(?:deploy|restart|write|mutat|config change)|(?:deploy|restart).*(?:production|prod\b)/,
    consequential_write: /(?:inventory|financial|transaction|payment).*(?:write|update|mutat|change)/,
    destructive_operation: /(?:delete|drop|truncate|reset --hard|force.push|destructive rewrite)/,
    broad_contract: /(?:shared|cross[- ]module|multiple modules).*(?:contract|interface|dependency)/,
    conflicting_evidence: /(?:contradict|conflict|inconsistent).*(?:assumption|implementation|evidence)/
  };
  return match[evidence.kind].test(body) && evidence.summary.split(/\W+/).filter(word => word.length > 4 && body.includes(word.toLowerCase())).length >= 2;
}
