import * as vscode from 'vscode';
import { NxToolResult, ReadFileStamp } from './productionTools';
import { resolveWorkspacePath } from './workspaceBoundary';

interface CoveredRead {
  path: string; startLine: number; endLine: number; nextStartLine?: number;
  content: string; fileStamp: ReadFileStamp;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = (value: unknown): value is ReadFileStamp => object(value) &&
  ['ctime', 'mtime', 'size'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
const sameStamp = (a: ReadFileStamp, b: ReadFileStamp) => a.ctime === b.ctime && a.mtime === b.mtime && a.size === b.size;

/** Short-lived coverage for complete read results already in this worker's message history. */
export class ReadCoverage {
  private readonly entries: CoveredRead[] = [];
  clear(): void { this.entries.length = 0; }
  record(result: NxToolResult): void {
    if (!result.success || !object(result.structuredData)) { return; }
    const data = result.structuredData;
    const { path, startLine, endLine, nextStartLine, content, rangeComplete, fileStamp } = data;
    if (rangeComplete !== true || typeof path !== 'string' || !Number.isInteger(startLine) || !Number.isInteger(endLine) ||
      (startLine as number) < 1 || (endLine as number) < (startLine as number) || typeof content !== 'string' ||
      content.length > 8000 || !stamp(fileStamp) || (nextStartLine !== undefined && !Number.isInteger(nextStartLine))) { return; }
    if (content.split('\n').length < (endLine as number) - (startLine as number) + 1) { return; }
    this.entries.push({ path, startLine: startLine as number, endLine: endLine as number,
      nextStartLine: nextStartLine as number | undefined, content, fileStamp });
    if (this.entries.length > 8) { this.entries.shift(); }
  }
  async reuse(input: object): Promise<NxToolResult | undefined> {
    if (!object(input) || typeof input.path !== 'string' || Object.keys(input).some(key => !['path', 'startLine', 'endLine'].includes(key))) { return undefined; }
    const start = input.startLine === undefined ? 1 : input.startLine;
    const end = input.endLine === undefined ? (start as number) + 199 : input.endLine;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 1 || (end as number) < (start as number) ||
      (end as number) - (start as number) > 199) { return undefined; }
    const entry = [...this.entries].reverse().find(item => item.path === input.path && (start as number) >= item.startLine &&
      (start as number) <= item.endLine && ((end as number) <= item.endLine || item.nextStartLine === undefined));
    if (!entry) { return undefined; }
    try {
      const uri = await resolveWorkspacePath(entry.path, true);
      if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty)) { return undefined; }
      if (!sameStamp(entry.fileStamp, await vscode.workspace.fs.stat(uri))) {
        this.entries.splice(this.entries.indexOf(entry), 1);
        return undefined;
      }
    } catch { this.entries.splice(this.entries.indexOf(entry), 1); return undefined; }
    const actualEnd = Math.min(end as number, entry.endLine);
    const content = entry.content.split('\n').slice((start as number) - entry.startLine, actualEnd - entry.startLine + 1).join('\n');
    const nextStartLine = actualEnd < entry.endLine || entry.nextStartLine !== undefined ? actualEnd + 1 : undefined;
    return { success: true, summary: `Reused ${entry.path} lines ${start}-${actualEnd} from an earlier complete read.`,
      structuredData: { path: entry.path, startLine: start, endLine: actualEnd, nextStartLine, content,
        rangeComplete: true, fileStamp: entry.fileStamp, cached: true }, truncated: nextStartLine !== undefined };
  }
}
