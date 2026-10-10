import { Route } from './route';
import { Intent } from './router';

export type Phase = 'plan' | 'implement' | 'debug' | 'test' | 'review' | 'investigate';
export interface NxSessionState {
  version: 1;
  sessionId: string;
  currentObjective?: string;
  phase?: Phase;
  activeTargets: string[];
  recentActions: string[];
  lastOutcome?: string;
  recentError?: string;
  pendingNextStep?: string;
  route?: Route;
  updatedAt: string;
}
const phases = new Set<Phase>(['plan', 'implement', 'debug', 'test', 'review', 'investigate']);
const routes = new Set<Route>(['LOW', 'MEDIUM', 'HIGH']);
const limits = { currentObjective: 700, lastOutcome: 400, recentError: 400, pendingNextStep: 400 } as const;
const short = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') { return undefined; }
  const clean = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .trim();
  return clean ? clean.slice(0, max) : undefined;
};
const list = (value: unknown, count: number, length: number): string[] => Array.isArray(value)
  ? value.slice(0, count * 2).map(item => short(item, length)).filter((item): item is string => !!item).slice(0, count)
  : [];
export function parseSessionState(value: unknown): NxSessionState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.sessionId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(raw.sessionId)) { return undefined; }
  if (!Array.isArray(raw.activeTargets) || !Array.isArray(raw.recentActions)) { return undefined; }
  return {
    version: 1, sessionId: raw.sessionId,
    currentObjective: short(raw.currentObjective, limits.currentObjective),
    phase: phases.has(raw.phase as Phase) ? raw.phase as Phase : undefined,
    activeTargets: list(raw.activeTargets, 4, 200), recentActions: list(raw.recentActions, 4, 180),
    lastOutcome: short(raw.lastOutcome, limits.lastOutcome), recentError: short(raw.recentError, limits.recentError),
    pendingNextStep: short(raw.pendingNextStep, limits.pendingNextStep),
    route: routes.has(raw.route as Route) ? raw.route as Route : undefined,
    updatedAt: typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : new Date().toISOString()
  };
}
export function isTerseContinuation(prompt: string): boolean {
  const text = prompt.trim();
  return /^(?:ทำต่อเลย|ทำต่อ|แก้ต่อ|ลองอีกที|ลองใหม่|ลองเลย|ลอง test|test ดู|ยัง error อยู่(?: แก้ต่อ)?|ยังไม่ผ่าน(?: แก้ต่อ)?|โอเค|แล้วไงต่อ|continue|go ahead|try again|test it|run tests?|still failing|fix it|fix this)[.!?\s]*$/i.test(text);
}
export function isNewObjective(prompt: string): boolean {
  return /^(?:ทีนี้|ต่อไป|เปลี่ยนไป|คราวนี้)/.test(prompt) || /^(?:now|next|switch to|instead)\b/i.test(prompt) ||
    /^(?:ช่วยสร้าง|สร้าง|implement|create|build|add|fix|แก้|ช่วยดู|ดู)\s+.{8,}/i.test(prompt) && !isTerseContinuation(prompt);
}
function phaseFor(prompt: string, intent?: Intent): Phase | undefined {
  if (/ยัง\s*(?:error|ไม่ผ่าน)|แก้ต่อ|still failing|error|failed/i.test(prompt)) { return 'debug'; }
  if (/ลอง|test|verify|ทดสอบ/i.test(prompt)) { return 'test'; }
  if (/review|diff|รีวิว/i.test(prompt)) { return 'review'; }
  if (/วางโครง|plan|แผน/i.test(prompt)) { return 'plan'; }
  if (/ทำตามแผน|implement|ลงมือ|สร้าง|แก้|fix/i.test(prompt)) { return 'implement'; }
  if (/ตรวจ|investigate|ดู/i.test(prompt)) { return 'investigate'; }
  return intent && phases.has(intent as Phase) ? intent as Phase : undefined;
}
export interface StateUpdate {
  sessionId: string; prompt: string; normalizedTask?: string; intent?: Intent; route?: Route;
  activeTarget?: string; action?: string; outcome?: string; error?: string; pendingNextStep?: string;
  status: 'completed' | 'failed' | 'cancelled'; now?: string;
}
export function updateSessionState(previous: NxSessionState | undefined, input: StateUpdate): NxSessionState {
  const old = parseSessionState(previous);
  if (input.status === 'cancelled' && old) { return old; }
  const prompt = short(input.prompt, 800) ?? '';
  const fresh = !isTerseContinuation(prompt) && (!!prompt && (!old?.currentObjective || isNewObjective(prompt)));
  const objective = fresh ? short(input.normalizedTask, limits.currentObjective) ?? prompt.slice(0, limits.currentObjective) : old?.currentObjective;
  const phase = phaseFor(prompt, isTerseContinuation(prompt) ? undefined : input.intent) ??
    (/^ลองเลย$/.test(prompt) && /test|ทดสอบ/i.test(old?.pendingNextStep ?? '') ? 'test' : undefined) ?? old?.phase;
  const target = short(input.activeTarget, 200);
  const targets = fresh ? (target ? [target] : []) : [target, ...(old?.activeTargets ?? [])].filter((item): item is string => !!item);
  const action = short(input.action, 180);
  const outcome = input.status === 'failed' ? (short(input.outcome, limits.lastOutcome) ?? 'Turn failed') : short(input.outcome, limits.lastOutcome);
  return parseSessionState({ version: 1, sessionId: input.sessionId, currentObjective: objective, phase,
    activeTargets: [...new Set(targets)].slice(0, 4), recentActions: [action, ...(fresh ? [] : old?.recentActions ?? [])].filter(Boolean).slice(0, 4),
    lastOutcome: outcome ?? (fresh ? undefined : old?.lastOutcome), recentError: input.status === 'failed' ? short(input.error, limits.recentError) : fresh ? undefined : old?.recentError,
    pendingNextStep: input.pendingNextStep ? short(input.pendingNextStep, limits.pendingNextStep) : fresh ? undefined : old?.pendingNextStep,
    route: input.route, updatedAt: input.now ?? new Date().toISOString() })!;
}
export function compactSessionState(state: NxSessionState | undefined): string | undefined {
  if (!state?.currentObjective && !state?.pendingNextStep) { return undefined; }
  return [state.currentObjective && `objective: ${state.currentObjective}`, state.phase && `phase: ${state.phase}`,
    state.activeTargets.length && `targets: ${state.activeTargets.join(', ')}`,
    state.recentActions.length && `recent actions: ${state.recentActions.join('; ')}`,
    state.lastOutcome && `last outcome: ${state.lastOutcome}`, state.pendingNextStep && `pending next step: ${state.pendingNextStep}`]
    .filter(Boolean).join('\n').slice(0, 1800);
}
