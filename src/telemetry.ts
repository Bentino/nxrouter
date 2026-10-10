import * as vscode from 'vscode';
import { randomUUID, createHash } from 'node:crypto';
import { Route } from './route';
import { retentionDays, telemetryEnabled } from './config';

export interface ModelPricing { inputPerMillion: number; outputPerMillion: number }
// No model pricing is assumed. Configure verified rates here when available.
export const pricing: Record<string, ModelPricing> = {};
export function estimateCost(model: string, input?: number, output?: number): number | undefined {
  const rate = pricing[model];
  return rate && input !== undefined && output !== undefined ? (input * rate.inputPerMillion + output * rate.outputPerMillion) / 1_000_000 : undefined;
}
export interface ModelRecord {
  session_id: string; turn_id: string; request_id: string; role: 'router' | 'worker'; provider: string; model: string; effort?: string;
  route?: Route;
  observed_input_tokens?: number; observed_output_tokens?: number; duration_ms: number; success: boolean;
  estimated_api_equivalent_cost_usd?: number; at: string;
}
export interface TurnRecord {
  manual_provider_switch?: boolean; context_carry_mode?: 'fresh' | 'selected';
  session_id: string; turn_id: string; initial_route: Route; final_route: Route; confidence: number; retry_count: number;
  provider_id?: string; provider_segment_id?: string; routing_mode?: 'auto' | 'manual'; model_id?: string; effort?: string;
  auto_available_at_execution?: boolean; mapping_validation_failure?: 'unconfigured' | 'unavailable' | 'connection' | 'manual_model_unavailable';
  manual_override?: Route; enriched_route?: Route; critical_unknown_count?: number; enrichment_performed?: boolean; enrichment_failure?: string;
  risk_floor?: Route; risk_gate_rules?: string[]; router_request_count?: number; duration_ms: number; status: 'completed' | 'partial' | 'failed' | 'cancelled'; at: string;
  worker_iterations?: number; worker_model_requests?: number; worker_tool_calls?: number; worker_stop_reason?: string;
  initial_final_route?: Route; final_worker_route?: Route; escalation_count?: number; escalated?: boolean;
  escalation_from?: Route; escalation_to?: Route; escalation_rule_ids?: string[]; escalation_completed?: boolean;
  escalation_events?: Array<{ from: Route; to: Route; rule_ids: string[]; completed: boolean }>;
}
type FileName = 'sessions' | 'turns' | 'model-requests' | 'tool-events';
export class Telemetry {
  private pending: Promise<void> = Promise.resolve();
  readonly root: vscode.Uri;
  readonly workspaceId: string;
  constructor(private readonly extension: vscode.ExtensionContext) {
    this.root = vscode.Uri.joinPath(extension.globalStorageUri, 'telemetry');
    this.workspaceId = createHash('sha256').update(vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()).join('|') ?? 'empty').digest('hex');
  }
  get enabled(): boolean { return telemetryEnabled(); }
  private async read(file: FileName): Promise<any[]> {
    try { const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, `${file}.jsonl`)); return Buffer.from(bytes).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return []; } throw error; }
  }
  private enqueue(work: () => Promise<void>): Promise<void> { const next = this.pending.then(work); this.pending = next.catch(() => {}); return next; }
  append(file: FileName, value: object): Promise<void> {
    if (!this.enabled) { return Promise.resolve(); }
    return this.enqueue(async () => {
      await vscode.workspace.fs.createDirectory(this.root);
      const uri = vscode.Uri.joinPath(this.root, `${file}.jsonl`);
      // Serialized read/write keeps records intact in one extension host, including remote storage.
      let existing: Uint8Array;
      try { existing = await vscode.workspace.fs.readFile(uri); }
      catch (error) { if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { existing = new Uint8Array(); } else { throw error; } }
      await vscode.workspace.fs.writeFile(uri, Buffer.concat([Buffer.from(existing), Buffer.from(JSON.stringify(value) + '\n')]));
    });
  }
  async startSession(sessionId: string): Promise<void> {
    if (!this.enabled) return;
    await this.enqueue(async () => {
      await vscode.workspace.fs.createDirectory(this.root);
      const rows = (await this.read('sessions')).filter(row => row.session_id !== sessionId);
      // Refresh actual activity, including resumed chats whose identity aged out or was cleared.
      rows.push({ session_id: sessionId, workspace_id: this.workspaceId, at: new Date().toISOString() });
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.root, 'sessions.jsonl'), Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
    });
  }
  async recordModel(record: ModelRecord): Promise<void> { await this.append('model-requests', record); }
  async recordTurn(record: TurnRecord): Promise<void> { await this.append('turns', record); }
  async recordTool(record: object): Promise<void> { await this.append('tool-events', record); }
  async export(sessionId?: string): Promise<object> {
    await this.pending;
    const [sessions, turns, models, tools] = await Promise.all((['sessions','turns','model-requests','tool-events'] as FileName[]).map(file => this.read(file)));
    const filter = (rows: any[]) => sessionId ? rows.filter(row => row.session_id === sessionId) : rows;
    const data = { sessions: filter(sessions), turns: filter(turns), modelRequests: filter(models) as ModelRecord[], toolEvents: filter(tools) };
    const sum = (rows: any[], key: string) => rows.reduce((total, row) => total + (typeof row[key] === 'number' ? row[key] : 0), 0);
    const costKnown = data.modelRequests.filter(row => row.estimated_api_equivalent_cost_usd !== undefined);
    const inputKnown = data.modelRequests.filter(row => row.observed_input_tokens !== undefined);
    const outputKnown = data.modelRequests.filter(row => row.observed_output_tokens !== undefined);
    return { schemaVersion: 1, tokenMeasurement: 'model_count_tokens_observed_not_provider_usage', summary: {
      sessions: data.sessions.length, turns: data.turns.length, router_requests: data.modelRequests.filter(row => row.role === 'router').length,
      worker_requests: data.modelRequests.filter(row => row.role === 'worker').length, tool_calls: data.toolEvents.length,
      low_worker_requests: data.modelRequests.filter(row => row.role === 'worker' && row.route === 'LOW').length,
      medium_worker_requests: data.modelRequests.filter(row => row.role === 'worker' && row.route === 'MEDIUM').length,
      high_worker_requests: data.modelRequests.filter(row => row.role === 'worker' && row.route === 'HIGH').length,
      escalations: data.turns.reduce((n, row) => n + (row.escalation_count ?? 0), 0),
      luna_requests: data.modelRequests.filter(row => /luna/i.test(row.model)).length,
      sol_requests: data.modelRequests.filter(row => /sol/i.test(row.model)).length,
      astra_requests: data.modelRequests.filter(row => /astra/i.test(row.model)).length,
      observed_input_tokens: inputKnown.length ? sum(inputKnown, 'observed_input_tokens') : null,
      observed_output_tokens: outputKnown.length ? sum(outputKnown, 'observed_output_tokens') : null,
      input_token_unavailable_requests: data.modelRequests.length - inputKnown.length,
      output_token_unavailable_requests: data.modelRequests.length - outputKnown.length,
      estimated_api_equivalent_cost_usd: costKnown.length === data.modelRequests.length && costKnown.length ? sum(costKnown, 'estimated_api_equivalent_cost_usd') : null,
      cost_unavailable_requests: data.modelRequests.length - costKnown.length,
      total_duration_ms: sum(data.turns, 'duration_ms'), retries: sum(data.turns, 'retry_count'),
      manual_overrides: data.turns.filter(row => row.manual_override).length,
      completed_turns: data.turns.filter(row => row.status === 'completed').length,
      partial_turns: data.turns.filter(row => row.status === 'partial').length,
      failed_turns: data.turns.filter(row => row.status === 'failed').length,
      cancelled_turns: data.turns.filter(row => row.status === 'cancelled').length
    }, ...data };
  }
  async clear(sessionId?: string, workspaceOnly = false): Promise<void> {
    await this.enqueue(async () => {
      const workspaceSessions = workspaceOnly ? new Set((await this.read('sessions')).filter(row => row.workspace_id === this.workspaceId).map(row => row.session_id)) : undefined;
      for (const file of ['sessions','turns','model-requests','tool-events'] as FileName[]) {
        const rows = await this.read(file);
        const kept = sessionId ? rows.filter(row => row.session_id !== sessionId) : workspaceSessions ? rows.filter(row => !workspaceSessions.has(row.session_id)) : [];
        const uri = vscode.Uri.joinPath(this.root, `${file}.jsonl`);
        if (rows.length || kept.length) { await vscode.workspace.fs.writeFile(uri, Buffer.from(kept.map(row => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''))); }
      }
    });
  }
  async applyRetention(): Promise<void> {
    if (!this.enabled) { return; }
    const days = retentionDays();
    const cutoff = Date.now() - days * 86400000;
    await this.enqueue(async () => {
      for (const file of ['sessions','turns','model-requests','tool-events'] as FileName[]) {
        const rows = await this.read(file);
        const kept = rows.filter(row => Date.parse(row.at) >= cutoff);
        if (kept.length !== rows.length) { await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.root, `${file}.jsonl`), Buffer.from(kept.map(row => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''))); }
      }
    });
  }
}
export function newId(): string { return randomUUID(); }
