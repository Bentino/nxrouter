import * as vscode from 'vscode';
import { resolveWorkspacePath } from './worker/workspaceBoundary';
import { CriticalUnknown, RoutingEvidence, contextBudget } from './guardrails';
import { TaskContext } from './router';

export interface EnrichmentResult { context: TaskContext; evidence: RoutingEvidence; inspectedFiles: number; inspectedCharacters: number; failure?: string }
export type Enricher = (context: TaskContext, unknowns: CriticalUnknown[], token?: vscode.CancellationToken) => Promise<EnrichmentResult>;
const cancellable = (token?: vscode.CancellationToken) => { if (token?.isCancellationRequested) { throw new vscode.CancellationError(); } };
/** Inspect only an explicitly attached file or active editor in the workspace. Never crawl. */
export function createVsCodeEnricher(references: readonly vscode.ChatPromptReference[] = []): Enricher {
  return async (context, unknowns, token) => {
    cancellable(token);
    const facts: string[] = []; const evidence: RoutingEvidence = {};
    const uris: { uri: vscode.Uri; range?: vscode.Range }[] = [];
    for (const reference of references) {
      const value = reference.value;
      const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
      if (uri && vscode.workspace.getWorkspaceFolder(uri)) { uris.push({ uri, range: value instanceof vscode.Location ? value.range : undefined }); }
    }
    const supplied = context.references?.filter(ref => (ref.descriptor.kind === 'file' || ref.descriptor.kind === 'selection') && !ref.descriptor.scope) ?? [];
    const active = supplied.length ? undefined : vscode.window.activeTextEditor?.document.uri;
    if (active && vscode.workspace.getWorkspaceFolder(active)) { uris.push({ uri: active, range: vscode.window.activeTextEditor?.selection.isEmpty ? undefined : vscode.window.activeTextEditor?.selection }); }
    const suppliedPaths = new Set(supplied.map(ref => 'path' in ref.descriptor ? ref.descriptor.path : undefined));
    const distinct = [...new Map(uris.filter(item => !suppliedPaths.has(vscode.workspace.asRelativePath(item.uri))).map(item => [item.uri.toString(), item])).values()].slice(0, contextBudget.enrichedFiles);
    const sources: { name: string; content?: string; uri?: vscode.Uri; range?: vscode.Range }[] = [...supplied.map(ref => ({ name: 'path' in ref.descriptor ? ref.descriptor.path! : '', content: ref.content })), ...distinct.map(item => ({ ...item, name: vscode.workspace.asRelativePath(item.uri), content: undefined }))].slice(0, contextBudget.enrichedFiles);
    let characters = 0; let inspectedFiles = 0;
    for (const item of sources) {
      cancellable(token);
      try {
        let sourceText = item.content;
        if (sourceText === undefined) {
          if (!item.uri) throw new Error('Missing enrichment source');
          const contained = await resolveWorkspacePath(vscode.workspace.asRelativePath(item.uri), true);
          sourceText = (await vscode.workspace.openTextDocument(contained)).getText(item.range);
        }
        const available = contextBudget.enrichedCharacters - characters;
        if (available <= 0) { break; }
        const source = sourceText.slice(0, available);
        characters += source.length; inspectedFiles++;
        const name = item.name.slice(0, 300);
        evidence.targetKnown = true;
        facts.push(`Target file: ${name}.`);
        if (unknowns.some(item => item.kind === 'existing_data')) {
          const count = source.match(/(?:existing[_ -]?records|record[_ -]?count|row[_ -]?count|node[_ -]?count)\s*[:=]\s*(\d+)/i);
          if (count) {
            const value = Number(count[1]);
            evidence.existingRecords = value > 0;
            evidence.existingDataStatus = value > 0 ? 'present' : 'absent';
            facts.push(`Target evidence declares ${value} existing records.`);
          } else if (/field_storage_config|field\.storage\./i.test(source)) {
            facts.push('Target contains a field storage definition; record count remains unknown.');
          }
        }
        if (unknowns.some(item => item.kind === 'security_boundary') && /permissions\.yml$|routing\.yml$|access/i.test(name)) {
          facts.push('Target is a permissions, routing, or access definition.');
        }
      } catch (error) {
        if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
        return { context, evidence, inspectedFiles, inspectedCharacters: characters, failure: error instanceof Error ? error.name : 'enrichment-error' };
      }
    }
    cancellable(token);
    evidence.facts = facts.slice(0, 4);
    return { context: { ...context, enrichmentFacts: evidence.facts }, evidence, inspectedFiles, inspectedCharacters: characters };
  };
}
