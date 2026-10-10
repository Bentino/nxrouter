import * as vscode from 'vscode';
import { NxProvider, NxProviderProfile } from '../runtime/providers';
import { validateAutoMapping } from '../runtime/autoConfiguration';

/** Test-only direct provider. Never imported or registered by production activation. */
export class BoundaryFixtureProvider implements NxProvider {
  readonly label: string;
  connected = true;
  valid = true;
  fail = false;
  calls: { modelId: string; messages: readonly vscode.LanguageModelChatMessage[] }[] = [];
  nextPart?: vscode.LanguageModelToolCallPart;
  constructor(readonly id = 'boundary-fixture') { this.label = `Local ${id}`; }
  async connectionStatus() { return this.connected ? 'connected' as const : 'disconnected' as const; }
  profile(): NxProviderProfile {
    return { providerId: this.id, auto: { router: { modelId: this.valid ? `${this.id}-router` : '' }, tiers: {
      LOW: { modelId: `${this.id}-low` }, MEDIUM: { modelId: `${this.id}-medium` }, HIGH: { modelId: `${this.id}-high` }
    } } };
  }
  async listModels() { return ['router', 'low', 'medium', 'high'].map(tier => ({ id: `${this.id}-${tier}`, name: `${this.label} ${tier}`, effortOptions: ['fixture-effort'] })); }
  async autoAvailability() { return validateAutoMapping(this.profile(), (await this.listModels()).map(model => model.id), this.connected); }
  async resolveModel(selection: { modelId: string; effort?: string }) {
    if (!this.connected || !(await this.listModels()).some(model => model.id === selection.modelId)) return;
    if (selection.effort && selection.effort !== 'fixture-effort') throw new Error('Unsupported effort');
    return { id: selection.modelId, vendor: this.id, countTokens: async () => 1,
      sendRequest: async (messages: readonly vscode.LanguageModelChatMessage[]) => {
        this.calls.push({ modelId: selection.modelId, messages });
        if (this.fail) throw new Error('Fixture request failure');
        const part = selection.modelId.endsWith('-router') ? undefined : this.nextPart; if (part) this.nextPart = undefined;
        const text = selection.modelId.endsWith('-router') ? JSON.stringify({ route: 'MEDIUM', confidence: 0.98, reason: 'Bounded read-only request', normalized_task: 'Explain the local project', intent: 'investigate', scope: 'single_file', needs_more_context: false, missing_context: [], risk_flags: [] }) : `Answer from ${this.id}`;
        return { text: (async function* () { yield text; })(), stream: (async function* () { yield part ?? new vscode.LanguageModelTextPart(text); })() };
      } } as unknown as vscode.LanguageModelChat;
  }
}
