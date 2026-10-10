import { Route } from './route';
import { RouterResult, TaskContext } from './router';

export interface CriticalUnknown { kind: 'environment' | 'existing_data' | 'security_boundary' | 'mutation_scope' | 'destructive_operation' | 'production_impact' | 'financial_or_inventory_write' | 'target_identity' | 'other'; question: string; reason: string }
export interface RoutingEvidence {
  targetKnown?: boolean;
  existingRecords?: boolean;
  existingDataStatus?: 'present' | 'absent' | 'unknown';
  productionTarget?: boolean;
  operation?: 'read' | 'write' | 'unknown';
  securityChange?: boolean;
  destructive?: boolean;
  consequentialWrite?: boolean;
  broadContractChange?: boolean;
  facts?: string[];
}
export interface RiskGateResult { minimumRoute: Route; triggeredRules: string[]; reasons: string[] }
export const contextBudget = { initialPrompt: 8000, initialState: 1000, enrichedFiles: 2, enrichedCharacters: 4000, enrichmentPasses: 1 } as const;
const order: Record<Route, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export function maxRoute(...routes: Route[]): Route { return routes.reduce((best, route) => order[route] > order[best] ? route : best, 'LOW'); }
const readIntent = /\b(explain|inspect|read|show|list|check|diagnos(?:e|is)|investigat\w*|review|audit|analy[sz]e|ดู|ตรวจ|อ่าน|อธิบาย)\b/i;
const writeIntent = /\b(implement|change|modify|mutation|update|add|remove|delete|drop|truncate|rewrite|migrat\w*|deploy|restart|set|grant|revoke|create|fix|แก้|เปลี่ยน|เพิ่ม|ลบ)\b/i;
const security = /\b(auth(?:entication|orization)?|permission\w*|access control|access rule\w*|role capabilit\w*|security[- ]sensitive|สิทธิ์|การเข้าถึง)\b/i;
const schema = /\b(schema|field(?: storage| type)?|data model|column|entity (?:type|reference)|storage type|โครงสร้างข้อมูล)\b/i;
const destructive = /\b(delete|drop|truncate|destroy|wipe|erase|destructive rewrite|force[- ]push|history rewrite|ลบ)\b/i;
const financial = /\b(payment|charge|refund|transfer|balance|transaction|inventory|stock|order fulfillment|การเงิน|สต็อก)\b/i;
const existingDataAssertion = /\b(populated|existing[- ]data|existing records|has data|contains data|already has records)\b/i;
const architecture = /\b(system architecture|architecture decision|cross[- ]module contract|cross[- ]system interface|interface redesign|สถาปัตยกรรม)\b/i;
const production = /\b(production|prod\b|โปรดักชัน)\b/i;
const mechanical = /\b(rename|display name|label|format|typo|namespace typo|replace exact|เปลี่ยนชื่อ|จัดรูปแบบ)\b/i;
const terse = /^(?:อ่า\s*)?(?:แก้ไขหน่อย|ทำต่อเลย|continue|fix it|do it|go ahead|ลองใหม่|โอเค)[.!\s]*$/i;
function statement(context: TaskContext, result: RouterResult): string { return `${context.userPrompt}\n${context.recentTaskState ?? ''}\n${result.normalized_task}`; }
function mode(context: TaskContext, result: RouterResult, evidence: RoutingEvidence): 'read' | 'write' | 'unknown' {
  if (evidence.operation && evidence.operation !== 'unknown') { return evidence.operation; }
  const raw = `${context.userPrompt}\n${context.recentTaskState ?? ''}`;
  if (/^\s*(?:please\s+)?(?:explain|inspect|read|show|list|check|diagnos(?:e|is)|investigat\w*|review|audit|analy[sz]e|ดู|ตรวจ|อ่าน|อธิบาย)\b/i.test(context.userPrompt)) { return 'read'; }
  if (writeIntent.test(raw) || /(?:ช่วย)?(?:แก้|เปลี่ยน|เพิ่ม|ลบ|สร้าง|ทำต่อ)/.test(context.userPrompt) || writeIntent.test(result.normalized_task)) { return 'write'; }
  if (readIntent.test(raw) || ['review','investigate','plan'].includes(result.intent)) { return 'read'; }
  return 'unknown';
}
export function detectCriticalUnknowns(context: TaskContext, result: RouterResult, evidence: RoutingEvidence = {}): CriticalUnknown[] {
  const task = statement(context, result); const operation = mode(context, result, evidence);
  const unknowns: CriticalUnknown[] = [];
  const add = (kind: CriticalUnknown['kind'], question: string, reason: string) => { if (!unknowns.some(item => item.kind === kind)) { unknowns.push({ kind, question, reason }); } };
  if (operation === 'write' && schema.test(task) && evidence.existingDataStatus === undefined && evidence.existingRecords === undefined &&
      (result.unknowns.some(item => /data|record|populat|migration|ข้อมูล/i.test(item)) || /\b(this|existing|current)\s+(?:Drupal\s+)?field\b/i.test(task))) {
    add('existing_data', 'Does the targeted schema already contain records?', 'Existing records can require a migration and a HIGH route.');
  }
  if (operation === 'write' && (production.test(task) || result.unknowns.some(item => /environment|production|staging|สภาพแวดล้อม/i.test(item))) &&
      context.environment === undefined && evidence.productionTarget === undefined) {
    add('environment', 'Which environment will be changed?', 'Production mutation requires HIGH.');
  }
  if (operation === 'write' && destructive.test(task) && result.unknowns.some(item => /scope|which|target|what|ไหน|ขอบเขต/i.test(item)) && !context.activeTarget && !evidence.targetKnown) {
    add('mutation_scope', 'What is the exact destructive target?', 'Unknown scope can change the consequence of the operation.');
  }
  if (operation === 'write' && security.test(task) && result.unknowns.some(item => /permission|access|role|security|auth/i.test(item)) && !context.activeTarget && !evidence.targetKnown) {
    add('security_boundary', 'Which access boundary is affected?', 'The relevant permission or access handler can change risk.');
  }
  if (terse.test(context.userPrompt.trim()) && !context.recentTaskState && !context.activeTarget && !evidence.targetKnown) {
    add('target_identity', 'What task and target should be changed?', 'The terse request has no actionable task state.');
  }
  return unknowns;
}
export function evaluateRiskFloor(context: TaskContext, result: RouterResult, evidence: RoutingEvidence = {}, unresolved: CriticalUnknown[] = []): RiskGateResult {
  const task = statement(context, result); const operation = mode(context, result, evidence);
  const rules: string[] = []; const reasons: string[] = [];
  let minimumRoute: Route = 'LOW';
  const add = (route: Route, rule: string, reason: string) => { minimumRoute = maxRoute(minimumRoute, route); rules.push(rule); reasons.push(reason); };
  if (operation === 'write' && (evidence.securityChange || security.test(task))) { add('HIGH', 'SECURITY_ACCESS_CHANGE', 'The requested write changes authentication, authorization, or access control.'); }
  if (operation === 'write' && schema.test(task) && (evidence.existingRecords || evidence.existingDataStatus === 'present' || existingDataAssertion.test(`${context.userPrompt} ${context.recentTaskState ?? ''}`))) { add('HIGH', 'EXISTING_DATA_SCHEMA_MUTATION', 'A schema or storage change affects existing records.'); }
  if (operation === 'write' && (evidence.destructive || destructive.test(task))) { add('HIGH', 'DESTRUCTIVE_OPERATION', 'The requested operation can destroy or rewrite data.'); }
  if (operation === 'write' && (evidence.consequentialWrite || financial.test(task))) { add('HIGH', 'CONSEQUENTIAL_WRITE', 'The operation writes real financial, inventory, or transactional state.'); }
  if (operation === 'write' && (evidence.productionTarget || context.environment === 'production' || production.test(task))) { add('HIGH', 'PRODUCTION_MUTATION', 'The requested operation changes a production target.'); }
  if (evidence.broadContractChange || architecture.test(task) && (operation === 'write' || result.intent === 'plan')) { add('HIGH', 'ARCHITECTURE_CONTRACT', 'The task changes a broad architecture or cross-system contract.'); }
  if (unresolved.length) { add('MEDIUM', 'CRITICAL_CONTEXT_UNRESOLVED', 'A routing-critical fact remains unknown after bounded enrichment.'); }
  if (terse.test(context.userPrompt.trim()) && !context.recentTaskState && !context.activeTarget && !evidence.targetKnown) { add('MEDIUM', 'INSUFFICIENT_TASK_CONTEXT', 'The request lacks actionable task state.'); }
  if (result.intent === 'debug' || /\b(debug|fix|test failure|pagination|runtime behavior|investigat\w*|diagnos\w*)\b/i.test(task)) { add('MEDIUM', 'NONTRIVIAL_INVESTIGATION', 'The next action requires diagnosis or normal implementation.'); }
  const lowEligible = !!context.activeTarget || !!evidence.targetKnown || /\bfrom\s+\S+\s+to\s+\S+/i.test(context.userPrompt);
  if (!lowEligible || !mechanical.test(task) && operation !== 'read') { add('MEDIUM', 'LOW_NOT_ESTABLISHED', 'The task is not clearly mechanical, bounded, and tied to a known result.'); }
  return { minimumRoute, triggeredRules: rules, reasons };
}
