import * as path from 'node:path';
import type { NxToolResult } from './productionTools';

/** Presentation metadata only. Never forward tool input/result objects or result summaries. */
export interface ToolActivityInfo { label: string; target?: string; lineRange?: string; command?: string }
export function workspaceIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069:]/.test(value)) { return; }
  const slash = value.replace(/\\/g, '/');
  if (slash.startsWith('/') || slash.split('/').includes('..')) { return; }
  const normalized = path.posix.normalize(slash);
  return normalized !== '.' ? normalized : undefined;
}
export function verificationLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^(npm (test|run (check|build|lint|test|typecheck))|git diff --check|composer validate|phpunit|npx (tsc|eslint))$/.test(value) ? value : undefined;
}
export function toolActivity(name: string, input: object): ToolActivityInfo {
  const data = input as Record<string, unknown>;
  const labels: Record<string, string> = { nx_read: 'Read', nx_search: 'Search workspace', nx_diagnostics: 'Check diagnostics',
    nx_git_status: 'Check Git status', nx_git_diff: 'Read Git diff', nx_create_file: 'Create', nx_edit_file: 'Edit',
    nx_move_file: 'Move', nx_copy_file: 'Copy', nx_execute: 'Run verification', nx_request_escalation: 'Check route' };
  const target = ['nx_read', 'nx_diagnostics', 'nx_create_file', 'nx_edit_file'].includes(name) ? workspaceIdentity(data.path)
    : ['nx_move_file', 'nx_copy_file'].includes(name) ? workspaceIdentity(data.destination) : undefined;
  // Only exact, fixed verification commands; arbitrary args (including phpunit paths) stay private.
  const commandText = typeof data.command === 'string' && Array.isArray(data.args) ? [data.command, ...data.args].join(' ') : '';
  const command = name === 'nx_execute' ? verificationLabel(commandText) : undefined;
  const start = data.startLine ?? 1, end = data.endLine;
  const lineRange = name === 'nx_read' && Number.isInteger(start) && Number.isInteger(end) && Number(start) > 0 && Number(end) >= Number(start)
    && Number(end) <= 1000000 ? `${start}–${end}` : undefined;
  return { label: command ?? labels[name] ?? 'Workspace tool', ...(target ? { target } : {}), ...(lineRange ? { lineRange } : {}), ...(command ? { command } : {}) };
}
export function appliedTargets(name: string, result: NxToolResult | undefined): string[] {
  if (!result?.success || result.cancelled || result.rejected || !['nx_create_file', 'nx_edit_file', 'nx_move_file', 'nx_copy_file'].includes(name)) { return []; }
  const data = result.structuredData as { path?: unknown; source?: unknown; changed?: unknown } | undefined;
  if (data?.changed === false) { return []; }
  return [...new Set([data?.path, ...(name === 'nx_move_file' ? [data?.source] : [])].map(workspaceIdentity).filter((value): value is string => !!value))];
}
