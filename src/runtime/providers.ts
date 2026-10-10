import * as vscode from 'vscode';
import { Route } from '../route';
import { defaults, modelMapping, workerEfforts } from '../config';
import type { AutoConfiguration } from './autoConfiguration';

export interface NxModelSelection { modelId: string; effort?: string }
export interface NxProviderProfile {
  providerId: string;
  auto: { router: NxModelSelection; tiers: Record<Route, NxModelSelection> };
}
export interface NxProvider {
  readonly id: string;
  readonly label: string;
  connectionStatus(): Promise<'connected' | 'disconnected' | 'unavailable'>;
  listModels(): Promise<readonly { id: string; name: string; effortOptions?: readonly string[]; availability?: string }[]>;
  resolveModel(selection: NxModelSelection): Promise<vscode.LanguageModelChat | undefined>;
  profile?(): NxProviderProfile;
  autoAvailability?(): Promise<AutoConfiguration>;
}
export class NxProviderManager {
  constructor(private readonly providers: readonly NxProvider[]) {}
  all(): readonly NxProvider[] { return this.providers; }
  async summaries(): Promise<{ id: string; label: string; connection: 'connected' | 'disconnected' | 'unavailable'; selectable: boolean }[]> {
    return Promise.all(this.all().map(async provider => {
      let connection: 'connected' | 'disconnected' | 'unavailable' = 'unavailable';
      try { connection = await provider.connectionStatus(); } catch { /* No failover. */ }
      return { id: provider.id, label: provider.label, connection, selectable: connection === 'connected' };
    }));
  }
  require(id: string): NxProvider {
    const provider = this.all().find(item => item.id === id);
    if (!provider) { throw new Error(`NX provider ${id} is unavailable.`); }
    return provider;
  }
}
/** Existing VS Code Language Model bridge; account connection belongs to UI-01. */
export class VsCodeLmProvider implements NxProvider {
  constructor(readonly id: string, readonly label: string) {}
  async connectionStatus(): Promise<'connected' | 'unavailable'> {
    return (await vscode.lm.selectChatModels({ vendor: this.id })).length ? 'connected' : 'unavailable';
  }
  async listModels(): Promise<readonly { id: string; name: string }[]> {
    return (await vscode.lm.selectChatModels({ vendor: this.id })).map(model => ({ id: model.id, name: model.name }));
  }
  async resolveModel(selection: NxModelSelection): Promise<vscode.LanguageModelChat | undefined> {
    if (!selection.modelId.trim()) { throw new Error('NX model ID is empty.'); }
    return (await vscode.lm.selectChatModels({ vendor: this.id, id: selection.modelId }))[0];
  }
}
export function activeProfile(fixture: boolean): NxProviderProfile {
  return fixture ? { providerId: 'nx-spike', auto: {
    router: { modelId: 'gpt-6-luna', effort: 'low' },
    tiers: { LOW: { modelId: 'spike-low' }, MEDIUM: { modelId: 'spike-medium' }, HIGH: { modelId: 'spike-high' } }
  } } : { providerId: 'openai', auto: {
    router: { modelId: defaults.models.LOW, effort: 'low' },
    tiers: { get LOW() { return { modelId: modelMapping('LOW'), effort: workerEfforts.LOW }; },
      get MEDIUM() { return { modelId: modelMapping('MEDIUM'), effort: workerEfforts.MEDIUM }; },
      get HIGH() { return { modelId: modelMapping('HIGH'), effort: workerEfforts.HIGH }; } }
  } };
}
