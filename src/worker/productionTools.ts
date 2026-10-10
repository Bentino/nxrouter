import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { DiffContent } from '../workspace';
import { evaluateCommand, productionTools, ProductionToolName, ToolRiskClass, toolRisk } from './toolPolicy';
import { relativePath, resolveWorkspacePath, workspaceFolder } from './workspaceBoundary';
import { EscalationEvidence, extractRuntimeEvidence } from './escalation';
import { executionTimeoutMs, maxReadChars, maxSearchResults } from '../config';

export interface NxToolResult { success: boolean; cancelled?: boolean; rejected?: boolean; summary: string; errorCode?: string; truncated?: boolean; structuredData?: unknown; policyRuleIds?: string[]; escalationEvidence?: EscalationEvidence[] }
export interface ReadFileStamp { ctime: number; mtime: number; size: number }
const MAX_OUTPUT = 5 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, name: string, max = 500): string => { if (typeof v !== 'string' || !v || v.length > max) { throw new Error(`Invalid ${name}.`); } return v; };
const obj = (v: unknown): Record<string, unknown> => { if (!isObject(v)) { throw new Error('Expected object input.'); } return v; };
const cancelled = (token: vscode.CancellationToken) => { if (token.isCancellationRequested) { throw new vscode.CancellationError(); } };
const result = (summary: string, data?: unknown, truncated = false): NxToolResult => ({ success: true, summary, structuredData: data, truncated });
function searchGlob(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim() !== value) {
    throw new Error(`Invalid ${name}: remove leading/trailing whitespace from the glob.`);
  }
  if (typeof value !== 'string' || !value || value.length > 200 || /[{},]/.test(value) || value.includes('..')) {
    throw new Error(`Invalid ${name}: use one nonempty VS Code glob without braces, commas, or parent traversal.`);
  }
  const glob = value;
  return glob;
}
async function exists(uri: vscode.Uri): Promise<boolean> { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { if (e instanceof vscode.FileSystemError && e.code === 'FileNotFound') { return false; } throw e; } }
function textResult(value: NxToolResult): vscode.LanguageModelToolResult {
  let body = JSON.stringify(value);
  if (body.length > 13000) {
    const data = isObject(value.structuredData) ? { ...value.structuredData } : undefined;
    if (data) {
      for (const key of ['stdout', 'stderr', 'content']) {
        if (typeof data[key] === 'string') { data[key] = (data[key] as string).slice(0, 2000); }
      }
    }
    value = { ...value, structuredData: data, truncated: true };
    body = JSON.stringify(value);
    if (body.length > 13000) { body = JSON.stringify({ success: value.success, summary: value.summary.slice(0, 500), truncated: true, errorCode: value.errorCode }); }
  }
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(body)]);
}
function boundedText(bytes: Uint8Array, limit: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, Math.min(buffer.length, limit)).includes(0)) { throw new Error('Binary file is unsupported.'); }
  const truncated = buffer.length > limit;
  let end = truncated ? limit : buffer.length;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) { end--; }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end));
  return { text, truncated };
}
function lineNumber(value: unknown, name: string): number { if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1000000) { throw new Error(`Invalid ${name}.`); } return value as number; }
async function review(diff: DiffContent, target: vscode.Uri, before: string, after: string, token: vscode.CancellationToken): Promise<boolean> {
  const left = diff.set('before.txt', before), right = diff.set('proposed.txt', after);
  try {
    await vscode.commands.executeCommand('vscode.diff', left, right, `NX review: ${relativePath(target)}`);
    const answer = await vscode.window.showInformationMessage(`Apply proposed change to ${relativePath(target)}?`, { modal: true }, 'Apply');
    cancelled(token);
    return answer === 'Apply';
  } finally { diff.release(left); diff.release(right); }
}
function checkContent(content: unknown): string { if (typeof content !== 'string' || Buffer.byteLength(content) > maxReadChars()) { throw new Error(`Content must be text of at most ${maxReadChars()} characters.`); } return content; }
function parseRange(value: unknown, document: vscode.TextDocument): vscode.Range {
  const r = obj(value);
  const startLine = lineNumber(r.startLine, 'startLine') - 1, endLine = lineNumber(r.endLine, 'endLine') - 1;
  const startCharacter = r.startCharacter, endCharacter = r.endCharacter;
  if (!Number.isInteger(startCharacter) || !Number.isInteger(endCharacter) || (startCharacter as number) < 0 || (endCharacter as number) < 0 ||
    startLine >= document.lineCount || endLine >= document.lineCount || (startCharacter as number) > document.lineAt(startLine).text.length ||
    (endCharacter as number) > document.lineAt(endLine).text.length) { throw new Error('Edit range is outside the file.'); }
  const range = new vscode.Range(startLine, startCharacter as number, endLine, endCharacter as number);
  if (range.isEmpty && (startLine !== endLine || startCharacter !== endCharacter)) { throw new Error('Invalid edit range.'); }
  return range;
}
async function runProcess(command: string, args: string[], cwd: string, token: vscode.CancellationToken, timeoutMs = 30000): Promise<NxToolResult> {
  cancelled(token);
  return new Promise(resolve => {
    let stdout = '', stderr = '', truncated = false, done = false, timedOut = false, wasCancelled = false;
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== 'win32', env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else { child.kill('SIGKILL'); } };
    const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => { const prior = kind === 'stdout' ? stdout : stderr; const room = Math.max(0, MAX_OUTPUT - prior.length); const next = prior + chunk.toString('utf8').slice(0, room); if (chunk.length > room) { truncated = true; } if (kind === 'stdout') { stdout = next; } else { stderr = next; } };
    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk)); child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const subscription = token.onCancellationRequested(() => { wasCancelled = true; stop(); });
    const finish = (code: number | null, error?: Error) => { if (done) { return; } done = true; clearTimeout(timer); subscription.dispose(); resolve({ success: !error && !timedOut && !wasCancelled && code === 0, cancelled: wasCancelled, summary: wasCancelled ? 'Execution cancelled.' : timedOut ? 'Execution timed out.' : error ? error.message : `Exited with code ${code ?? 'unknown'}.`, errorCode: error ? 'PROCESS_ERROR' : timedOut ? 'TIMEOUT' : code === 0 ? undefined : 'NONZERO_EXIT', truncated, structuredData: { exitCode: code, stdout, stderr, durationMs: Date.now() - started } }); };
    const started = Date.now(); child.on('error', (error: Error) => finish(null, error)); child.on('close', code => finish(code));
  });
}
export class ProductionTool implements vscode.LanguageModelTool<Record<string, unknown>> {
  constructor(readonly name: ProductionToolName, private readonly diff: DiffContent,
    private readonly testApproval?: (target: vscode.Uri, before: string, after: string) => Promise<boolean>) {}
  private review(target: vscode.Uri, before: string, after: string, token: vscode.CancellationToken): Promise<boolean> {
    return this.testApproval ? this.testApproval(target, before, after) : review(this.diff, target, before, after, token);
  }
  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, unknown>>): vscode.PreparedToolInvocation {
    const risk: ToolRiskClass = toolRisk[this.name];
    const input = isObject(options.input) ? options.input : {};
    const target = typeof input.path === 'string' ? input.path.slice(0, 200) : typeof input.command === 'string' ? input.command.slice(0, 80) : this.name;
    return { invocationMessage: `${this.name}: ${target}`, ...(risk === 'SAFE' ? {} : { confirmationMessages: { title: `NX ${risk}: ${this.name}`, message: `${target}. ${risk === 'WRITE' && (this.name === productionTools.create || this.name === productionTools.edit) ? 'An exact diff and separate Apply prompt follow.' : 'Approve this specific operation.'}` } }) };
  }
  async invoke(options: vscode.LanguageModelToolInvocationOptions<Record<string, unknown>>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    let value: NxToolResult;
    try { cancelled(token); value = await this.execute(obj(options.input), token); }
    catch (error) { value = error instanceof vscode.CancellationError ? { success: false, cancelled: true, summary: 'Cancelled.', errorCode: 'CANCELLED' } : { success: false, summary: error instanceof Error ? error.message : String(error), errorCode: 'TOOL_ERROR' }; }
    return textResult(value);
  }
  private async execute(input: Record<string, unknown>, token: vscode.CancellationToken): Promise<NxToolResult> {
    const fields: Record<ProductionToolName, string[]> = {
      nx_read: ['path', 'startLine', 'endLine'], nx_search: ['query', 'include', 'exclude'], nx_diagnostics: ['path'],
      nx_git_status: [], nx_git_diff: ['cached'], nx_create_file: ['path', 'content'], nx_edit_file: ['path', 'edits'],
      nx_move_file: ['source', 'destination'], nx_copy_file: ['source', 'destination'], nx_execute: ['command', 'args', 'cwd', 'timeoutMs']
    };
    if (Object.keys(input).some(key => !fields[this.name].includes(key))) { throw new Error('Unsupported tool argument.'); }
    switch (this.name) {
      case 'nx_read': {
        const uri = await resolveWorkspacePath(str(input.path, 'path'), true);
        const stat = await vscode.workspace.fs.stat(uri); if (stat.size > 1024 * 1024) { throw new Error('File exceeds 1 MiB read limit.'); }
        const { text, truncated } = boundedText(await vscode.workspace.fs.readFile(uri), maxReadChars());
        const after = await vscode.workspace.fs.stat(uri);
        const lines = text.split('\n'), start = input.startLine === undefined ? 1 : lineNumber(input.startLine, 'startLine');
        const end = input.endLine === undefined ? Math.min(lines.length, start + 199) : lineNumber(input.endLine, 'endLine');
        if (end < start || end - start > 199) { throw new Error('Read range exceeds 200 lines.'); }
        if (start > lines.length) { throw new Error('Requested line is beyond the bounded read window.'); }
        const selected = lines.slice(start - 1, end).join('\n');
        const actualEnd = Math.min(end, lines.length);
        const resultLimit = 8000;
        const resultCapped = selected.length > resultLimit;
        const capped = resultCapped ? selected.slice(0, resultLimit) : selected;
        const lastBreak = resultCapped ? capped.lastIndexOf('\n') : -1;
        const completeLines = !resultCapped || lastBreak >= 0;
        const content = resultCapped && completeLines ? capped.slice(0, lastBreak) : capped;
        const deliveredEnd = resultCapped && completeLines ? start + content.split('\n').length - 1 :
          resultCapped ? start : actualEnd;
        const nextStartLine = resultCapped ? completeLines ? deliveredEnd + 1 : undefined : end < lines.length ? end + 1 : undefined;
        const unchanged = stat.ctime === after.ctime && stat.mtime === after.mtime && stat.size === after.size;
        const rangeComplete = unchanged && completeLines && (!truncated || deliveredEnd < lines.length);
        const fileStamp: ReadFileStamp = { ctime: after.ctime, mtime: after.mtime, size: after.size };
        return { ...result(`Read ${relativePath(uri)} lines ${start}-${deliveredEnd}${completeLines ? '' : ' (partial line)'}.`,
          { path: relativePath(uri), startLine: start, endLine: deliveredEnd, nextStartLine, content, rangeComplete, fileStamp },
          truncated || end < lines.length || resultCapped),
          escalationEvidence: extractRuntimeEvidence(content, relativePath(uri)) };
      }
      case 'nx_search': {
        const query = input.query === undefined ? undefined : str(input.query, 'query', 200);
        const include = input.include === undefined ? '**/*' : searchGlob(input.include, 'include');
        const exclude = input.exclude === undefined ? '**/{node_modules,.git,out}/**' : searchGlob(input.exclude, 'exclude');
        const matchLimit = maxSearchResults();
        const files = await vscode.workspace.findFiles(include, exclude, 1001, token);
        const matches: Array<{ path: string; line?: number; preview?: string }> = [];
        let truncated = files.length > 1000;
        for (const file of files.slice(0, 1000)) {
          cancelled(token); if (file.scheme !== 'file') { continue; }
          const rel = relativePath(file); await resolveWorkspacePath(rel, true);
          if (!query) { matches.push({ path: rel }); }
          else {
            const stat = await vscode.workspace.fs.stat(file); if (stat.size > maxReadChars()) { continue; }
            let body: string; try { body = boundedText(await vscode.workspace.fs.readFile(file), maxReadChars()).text; } catch { continue; }
            const lines = body.split('\n'); for (let i = 0; i < lines.length; i++) { if (lines[i].includes(query)) { matches.push({ path: rel, line: i + 1, preview: lines[i].slice(0, 200) }); if (matches.length >= matchLimit) { break; } } }
          }
          if (matches.length >= matchLimit) { truncated = true; break; }
        }
        const snippets = new Map<string, string[]>();
        for (const match of matches) { snippets.set(match.path, [...(snippets.get(match.path) ?? []), match.preview ?? '']); }
        return { ...result(`${matches.length} bounded match(es).`, { matches }, truncated),
          escalationEvidence: [...snippets].flatMap(([path, previews]) => extractRuntimeEvidence(previews.join('\n'), path)).slice(0, 3) };
      }
      case 'nx_diagnostics': {
        const target = input.path === undefined ? undefined : await resolveWorkspacePath(str(input.path, 'path'), true);
        const entries = target ? [[target, vscode.languages.getDiagnostics(target)] as const] : vscode.languages.getDiagnostics().filter(([uri]) => uri.scheme === 'file' && !!vscode.workspace.getWorkspaceFolder(uri));
        const rows: object[] = []; let truncated = false;
        for (const [uri, diagnostics] of entries) { const rel = relativePath(uri); await resolveWorkspacePath(rel, true); for (const d of diagnostics) { if (rows.length >= 50) { truncated = true; break; } rows.push({ path: rel, severity: vscode.DiagnosticSeverity[d.severity], message: d.message.slice(0, 500), startLine: d.range.start.line + 1, endLine: d.range.end.line + 1, source: d.source, code: typeof d.code === 'object' ? d.code.value : d.code }); } }
        return result(`${rows.length} diagnostic(s).`, { diagnostics: rows }, truncated);
      }
      case 'nx_git_status': case 'nx_git_diff': {
        const root = workspaceFolder().uri.fsPath;
        const args = this.name === 'nx_git_status' ? ['status', '--short'] : input.cached === true ? ['diff', '--cached', '--no-ext-diff'] : ['diff', '--no-ext-diff'];
        const output = await runProcess('git', args, root, token, 10000);
        return { ...output, summary: `${this.name}: ${output.summary}` };
      }
      case 'nx_create_file': {
        const uri = await resolveWorkspacePath(str(input.path, 'path'), false), content = checkContent(input.content);
        if (await exists(uri)) { throw new Error('Target already exists.'); }
        if (!await this.review(uri, '', content, token)) { return { success: false, rejected: true, summary: 'Create cancelled; no changes applied.' }; }
        cancelled(token);
        if (await exists(uri)) { throw new Error('Target changed during review.'); }
        const edit = new vscode.WorkspaceEdit(); edit.createFile(uri, { overwrite: false }); edit.insert(uri, new vscode.Position(0, 0), content);
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('WorkspaceEdit rejected.'); }
        const doc = await vscode.workspace.openTextDocument(uri); if (!await doc.save()) { throw new Error('Created file could not be saved.'); }
        return result(`Created ${relativePath(uri)}.`, { path: relativePath(uri) });
      }
      case 'nx_edit_file': {
        const uri = await resolveWorkspacePath(str(input.path, 'path'), true), doc = await vscode.workspace.openTextDocument(uri);
        if (doc.isDirty || Buffer.byteLength(doc.getText()) > maxReadChars()) { throw new Error('File is dirty or exceeds edit limit.'); }
        const entries = input.edits; if (!Array.isArray(entries) || !entries.length || entries.length > 20) { throw new Error('Expected 1-20 edits.'); }
        const changes = entries.map(e => {
          const item = obj(e); if (Object.keys(item).some(key => !['range', 'text', 'expectedText'].includes(key))) { throw new Error('Unsupported edit field.'); }
          const range = parseRange(item.range, doc), expectedText = checkContent(item.expectedText);
          if (doc.getText(range) !== expectedText) { throw new Error('Stale edit: expected text differs from current file.'); }
          return { range, text: checkContent(item.text) };
        });
        const sorted = [...changes].sort((a, b) => b.range.start.compareTo(a.range.start));
        for (let i = 1; i < sorted.length; i++) { if (sorted[i].range.end.isAfter(sorted[i - 1].range.start)) { throw new Error('Overlapping edits.'); } }
        let after = doc.getText(); for (const change of sorted) { after = after.slice(0, doc.offsetAt(change.range.start)) + change.text + after.slice(doc.offsetAt(change.range.end)); }
        const version = doc.version, before = doc.getText();
        if (!await this.review(uri, before, after, token)) { return { success: false, rejected: true, summary: 'Edit cancelled; no changes applied.' }; }
        cancelled(token);
        await resolveWorkspacePath(str(input.path, 'path'), true);
        if (doc.version !== version || doc.isDirty) { throw new Error('File changed during review.'); }
        const edit = new vscode.WorkspaceEdit(); for (const change of changes) { edit.replace(uri, change.range, change.text); }
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('WorkspaceEdit rejected.'); }
        if (!await doc.save()) { throw new Error('Edited file could not be saved.'); }
        return result(`Edited ${relativePath(uri)}.`, { path: relativePath(uri), changed: before !== after });
      }
      case 'nx_move_file': case 'nx_copy_file': {
        const from = await resolveWorkspacePath(str(input.source, 'source'), true), to = await resolveWorkspacePath(str(input.destination, 'destination'), false);
        if (await exists(to)) { throw new Error('Destination already exists.'); }
        cancelled(token);
        const answer = this.testApproval ? await this.testApproval(to, relativePath(from), relativePath(to)) ? 'Apply' : undefined :
          await vscode.window.showWarningMessage(`${this.name === 'nx_move_file' ? 'Move' : 'Copy'} ${relativePath(from)} to ${relativePath(to)}?`, { modal: true }, 'Apply');
        cancelled(token); if (answer !== 'Apply') { return { success: false, rejected: true, summary: 'Operation cancelled; no changes applied.' }; }
        await resolveWorkspacePath(str(input.source, 'source'), true); await resolveWorkspacePath(str(input.destination, 'destination'), false);
        if (await exists(to)) { throw new Error('Destination changed during review.'); }
        if (this.name === 'nx_move_file') { await vscode.workspace.fs.rename(from, to, { overwrite: false }); } else { await vscode.workspace.fs.copy(from, to, { overwrite: false }); }
        return result(`${this.name === 'nx_move_file' ? 'Moved' : 'Copied'} ${relativePath(from)} to ${relativePath(to)}.`, { path: relativePath(to), ...(this.name === 'nx_move_file' ? { source: relativePath(from) } : {}) });
      }
      case 'nx_execute': {
        const command = str(input.command, 'command', 80);
        if (!Array.isArray(input.args) || input.args.some(a => typeof a !== 'string')) { throw new Error('Invalid args.'); }
        const args = input.args as string[], policy = evaluateCommand(command, args);
        if (!policy.allowed) {
          const attempted = `${command} ${args.join(' ')}`;
          const kinds: EscalationEvidence['kind'][] = [];
          if (/\b(?:production|prod|deploy|restart|publish)\b/i.test(attempted)) { kinds.push('production_mutation'); }
          if (/\b(?:drop|truncate|delete|reset --hard|clean -fd|force|rm -rf)\b/i.test(attempted)) { kinds.push('destructive_operation'); }
          return { success: false, rejected: true, summary: policy.reason, errorCode: 'POLICY_REJECTED', policyRuleIds: policy.ruleIds,
            escalationEvidence: kinds.map(kind => ({ kind, summary: `Attempted prohibited ${kind.replace('_', ' ')} command.`, source: 'tool_result', provenance: 'structured_operation', targetRoute: 'HIGH' })) };
        }
        const cwd = input.cwd === undefined ? workspaceFolder().uri : await resolveWorkspacePath(str(input.cwd, 'cwd'), true, true);
        const timeoutMs = input.timeoutMs === undefined ? executionTimeoutMs() : input.timeoutMs;
        if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 120000) { throw new Error('Timeout must be 1-120 seconds.'); }
        const output = await runProcess(command, args, cwd.fsPath, token, timeoutMs as number);
        return { ...output, policyRuleIds: policy.ruleIds };
      }
    }
  }
}
