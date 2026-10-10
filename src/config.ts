import * as vscode from 'vscode';
import { Route } from './route';

export const defaults = {
  models: { LOW: 'gpt-6-luna', MEDIUM: 'gpt-6-sol', HIGH: 'gpt-6-astra' },
  telemetryEnabled: true, retentionDays: 90, timeoutSeconds: 30,
  maxReadChars: 65536, maxSearchResults: 30
} as const;
export const workerEfforts: Record<Route, string> = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };

export function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
export function modelMapping(route: Route): string {
  const value = vscode.workspace.getConfiguration('nxRouter.models').get<unknown>(route.toLowerCase(), defaults.models[route]);
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    throw new Error(`Configured ${route} worker model is invalid. Set nxRouter.models.${route.toLowerCase()} to a non-empty model ID.`);
  }
  return value;
}
export function telemetryEnabled(): boolean {
  const value = vscode.workspace.getConfiguration('nxRouter.telemetry').get<unknown>('enabled', defaults.telemetryEnabled);
  return typeof value === 'boolean' ? value : defaults.telemetryEnabled;
}
export function retentionDays(): number {
  return boundedInteger(vscode.workspace.getConfiguration('nxRouter.telemetry').get<unknown>('retentionDays'), defaults.retentionDays, 1, 3650);
}
export function executionTimeoutMs(): number {
  return boundedInteger(vscode.workspace.getConfiguration('nxRouter.execution').get<unknown>('timeoutSeconds'), defaults.timeoutSeconds, 1, 120) * 1000;
}
export function maxReadChars(): number {
  return boundedInteger(vscode.workspace.getConfiguration('nxRouter.tools').get<unknown>('maxReadChars'), defaults.maxReadChars, 1024, 65536);
}
export function maxSearchResults(): number {
  return boundedInteger(vscode.workspace.getConfiguration('nxRouter.tools').get<unknown>('maxSearchResults'), defaults.maxSearchResults, 1, 100);
}
