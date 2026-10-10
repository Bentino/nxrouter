import * as vscode from 'vscode';
import { ExecutionSessions } from './executionSessions';
import { invalidAutoMessage } from './autoConfiguration';
import { OpenAIConfiguration, OpenAIProvider } from './openaiProvider';

/** Revalidates on account and User Settings changes and deduplicates native warnings. */
export class OpenAIAvailabilityMonitor {
  private readonly changed = new vscode.EventEmitter<OpenAIConfiguration>();
  readonly onDidChange = this.changed.event;
  dispose(): void { this.changed.dispose(); }
  private warningKey?: string;
  private generation = 0;
  private current?: OpenAIConfiguration;
  constructor(private readonly provider: OpenAIProvider, private readonly sessions: ExecutionSessions,
    private readonly warn: (message: string) => void) {}
  state(): OpenAIConfiguration | undefined { return this.current; }
  async refresh(discover = false): Promise<OpenAIConfiguration> {
    const generation = ++this.generation;
    const result = discover ? await this.provider.refreshConfiguration() : await this.provider.configuration();
    if (generation !== this.generation) { return result; }
    this.current = result;
    this.sessions.reconcile(result.auto.available);
    this.changed.fire(result);
    if (result.state !== 'connected' || result.auto.available) { this.warningKey = undefined; return result; }
    const key = JSON.stringify([result.profileId, result.auto.mappings]);
    if (key !== this.warningKey) {
      this.warningKey = key;
      this.warn(`${invalidAutoMessage(result.auto)} Configure Models to choose an available model.`);
    }
    return result;
  }
}
