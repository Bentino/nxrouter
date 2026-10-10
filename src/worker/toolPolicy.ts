import { Route } from '../route';

export type ToolRiskClass = 'SAFE' | 'WRITE' | 'EXECUTE' | 'DANGEROUS' | 'CONTROL';
export const productionTools = {
  read: 'nx_read', search: 'nx_search', diagnostics: 'nx_diagnostics', gitStatus: 'nx_git_status', gitDiff: 'nx_git_diff',
  create: 'nx_create_file', edit: 'nx_edit_file', move: 'nx_move_file', copy: 'nx_copy_file', execute: 'nx_execute'
} as const;
export type ProductionToolName = typeof productionTools[keyof typeof productionTools];
export const toolRisk: Record<string, ToolRiskClass> = {
  nx_read: 'SAFE', nx_search: 'SAFE', nx_diagnostics: 'SAFE', nx_git_status: 'SAFE', nx_git_diff: 'SAFE',
  nx_create_file: 'WRITE', nx_edit_file: 'WRITE', nx_move_file: 'WRITE', nx_copy_file: 'WRITE', nx_execute: 'EXECUTE',
  nx_spike_safe: 'SAFE', nx_spike_write: 'WRITE', nx_spike_execute: 'EXECUTE', nx_spike_dangerous: 'DANGEROUS',
  nx_request_escalation: 'CONTROL'
};
export interface OperationPolicyResult { allowed: boolean; riskClass: ToolRiskClass; requiresFreshConfirmation: boolean; ruleIds: string[]; reason: string }
const denial = (riskClass: ToolRiskClass, rule: string, reason: string): OperationPolicyResult => ({ allowed: false, riskClass, requiresFreshConfirmation: riskClass === 'DANGEROUS', ruleIds: [rule], reason });
export function routeAllowsTool(route: Route, tool: string, intent?: string): boolean {
  const risk = toolRisk[tool];
  if (!risk || risk === 'DANGEROUS') { return false; }
  if (risk === 'CONTROL') { return true; }
  if (risk === 'SAFE') { return true; }
  if (risk === 'WRITE') { return route !== 'LOW' || (intent !== undefined && /\b(edit|create|write|rename|copy|move|fix|change)\b/i.test(intent)); }
  return route !== 'LOW';
}
export function evaluateCommand(command: string, args: string[]): OperationPolicyResult {
  if (!/^[a-zA-Z0-9._+-]{1,80}$/.test(command) || !Array.isArray(args) || args.length > 32 || args.some(a => typeof a !== 'string' || a.length > 500 || /[\x00-\x1f]/.test(a))) {
    return denial('EXECUTE', 'invalid-command', 'Invalid command or arguments.');
  }
  const exe = command.toLowerCase();
  const joined = `${exe} ${args.join(' ')}`.toLowerCase();
  if (/^(sh|bash|zsh|fish|cmd|powershell|pwsh|sudo|su|env|eval|node|python|python3|perl|ruby|php|drush|docker|kubectl|ssh|scp|curl|wget)$/.test(exe)) {
    return denial('DANGEROUS', 'opaque-or-remote-command', 'Opaque, remote, or mutation-capable command is unavailable.');
  }
  if (/\b(production|prod|live|deploy|restart|migrate|migration|drop|truncate|database|db:|push|publish|force|reset|clean|rm|delete)\b/.test(joined)) {
    return denial('DANGEROUS', 'consequential-command', 'Potentially destructive or production operation is unavailable.');
  }
  const exact = (base: string, allowed: string[][]) => exe === base && allowed.some(pattern => pattern.length === args.length && pattern.every((x, i) => x === '*' || x === args[i]));
  const allowed = exact('npm', [['test'], ['run', 'check'], ['run', 'build'], ['run', 'lint'], ['run', 'test'], ['run', 'typecheck']]) ||
    exact('git', [['diff', '--check']]) || exact('composer', [['validate']]) || exact('phpunit', [[]]) ||
    (exe === 'phpunit' && args.every(a => !a.startsWith('-') && !a.includes('..'))) ||
    (exe === 'npx' && args.length === 1 && ['tsc', 'eslint'].includes(args[0]));
  return allowed ? { allowed: true, riskClass: 'EXECUTE', requiresFreshConfirmation: false, ruleIds: ['verification-allowlist'], reason: 'Bounded verification command.' }
    : denial('EXECUTE', 'command-not-allowlisted', 'Command is not in the verification allowlist.');
}
