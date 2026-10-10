import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { resolveWorkspacePath, workspaceFolder, relativePath } from '../worker/workspaceBoundary';
import { NxReference, NxReferenceDescriptor, referenceLimits, referenceDescriptor, validateReferences } from './references';

export const contextKinds = ['Current file', 'Current selection', 'Files...', 'Diagnostics', 'Git diff'] as const;
export interface DraftReference { id: string; descriptor: NxReferenceDescriptor; provenance: NxReference['provenance']; crossProvider?: NxReference['crossProvider']; snapshot?: string; selectedFile?: { path: string; canonical: string; dev: number; ino: number; birthtimeMs: number } }
export class ContextError extends Error {}
const fail = (message: string): never => { throw new ContextError(message); };
export function contextAvailable(): boolean {
  try { workspaceFolder(); return !vscode.env.remoteName && !workspaceFolder().uri.authority; } catch { return false; }
}
export function contextPath(uri: vscode.Uri): string {
  if (!contextAvailable()) return fail('Context requires a trusted single local workspace.');
  if (uri.scheme !== 'file' || uri.authority) return fail('Choose a local workspace text file.');
  const relative = relativePath(uri);
  if (!referenceDescriptor({ kind: 'file', path: relative })) return fail('Choose a file inside the current workspace.');
  return relative;
}

/** Canonical key stays in host memory; display/persistence retain the user's relative identity. */
export async function draftReferenceKey(descriptor: NxReferenceDescriptor, selectedFile?: DraftReference['selectedFile']): Promise<string> {
  if (selectedFile) return `${descriptor.kind}:${selectedFile.canonical}`;
  if (descriptor.kind === 'diagnostics' || descriptor.kind === 'git_diff') return descriptor.kind;
  const uri = await resolveWorkspacePath(descriptor.path!, true);
  const canonical = await fs.realpath(uri.fsPath), realRoot = await fs.realpath(workspaceFolder().uri.fsPath);
  if (!canonical.startsWith(realRoot + path.sep)) return fail('Choose a file inside the workspace.');
  return descriptor.kind === 'selection' ? JSON.stringify({ ...descriptor, path: path.relative(realRoot, canonical).replaceAll(path.sep, '/') }) : `${descriptor.kind}:${canonical}`;
}

async function textFile(identity: string, includeText = true): Promise<string> {
  const uri = await resolveWorkspacePath(identity, true);
  // Open the canonical contained target without following a last-component symlink.
  const canonical = await fs.realpath(uri.fsPath);
  const root = await fs.realpath(workspaceFolder().uri.fsPath);
  if (!canonical.startsWith(root + path.sep)) return fail('Choose a file inside the workspace.');
  const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > referenceLimits.fileBytes) return fail('File exceeds 65,536 bytes. Attach a smaller selection.');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== stat.size) return fail('File changed while reading. Retry Send.');
    if (bytes.subarray(0, length).includes(0)) return fail('Binary files cannot be attached. Choose a text file.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); } catch { return fail('Only UTF-8 text files can be attached.'); }
    // Explicitly attached editor buffers are current text, including unsaved edits.
    const editor = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (editor && editor.offsetAt(new vscode.Position(editor.lineCount, 0)) > referenceLimits.individual) return fail('File exceeds 16,000 characters. Attach a smaller selection.');
    return includeText ? editor?.getText() ?? text : '';
  } finally { await handle.close(); }
}
/** The picker grants one exact file, never directory/tool access. Reject retargeted links/replaced files. */
async function selectedContents(grant: NonNullable<DraftReference['selectedFile']>): Promise<Pick<NxReference, 'content' | 'image'>> {
  if (await fs.realpath(grant.path) !== grant.canonical) return fail('Selected file changed. Attach it again.');
  const handle = await fs.open(grant.canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== grant.dev || stat.ino !== grant.ino || stat.birthtimeMs !== grant.birthtimeMs) return fail('Selected file changed or is not a regular file. Attach it again.');
    if (stat.size > referenceLimits.imageBytes) return fail('File exceeds 5 MiB. Attach a smaller file.');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length !== stat.size) return fail('File changed while reading. Retry Send.');
    const data = bytes.subarray(0, length);
    const png = data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii', 12, 16) === 'IHDR';
    const jpeg = data.length >= 4 && data[0] === 255 && data[1] === 216 && data[length - 2] === 255 && data[length - 1] === 217;
    if (png || jpeg) {
      if (jpeg) {
        let offset = 2, width = 0, height = 0;
        while (offset + 4 <= length) {
          if (data[offset++] !== 255) break;
          while (data[offset] === 255) offset++;
          const marker = data[offset++];
          if (marker === 218 || marker === 217) break;
          if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
          if (offset + 2 > length) break;
          const size = data.readUInt16BE(offset);
          if (size < 2 || offset + size > length) break;
          if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && size >= 8) {
            height = data.readUInt16BE(offset + 3); width = data.readUInt16BE(offset + 5); break;
          }
          offset += size;
        }
        if (!width || !height || width > 8192 || height > 8192) return fail('Choose a valid JPEG with dimensions at most 8192 × 8192.');
      }
      if (png && (!data.readUInt32BE(16) || !data.readUInt32BE(20) || data.readUInt32BE(16) > 8192 || data.readUInt32BE(20) > 8192)) return fail('PNG dimensions must be at most 8192 × 8192.');
      return { content: '', image: { mimeType: png ? 'image/png' : 'image/jpeg', data } };
    }
    if (/\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(grant.path)) return fail('Choose a valid PNG or JPEG image.');
    if (length > referenceLimits.fileBytes) return fail('Text file exceeds 65,536 bytes. Attach a smaller file.');
    if (data.includes(0)) return fail('Binary files cannot be attached. Choose UTF-8 text, PNG or JPEG.');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return fail('Choose UTF-8 text, PNG or JPEG.'); }
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && !doc.uri.authority && doc.uri.fsPath === grant.path);
    if (document && document.offsetAt(new vscode.Position(document.lineCount, 0)) > referenceLimits.individual) return fail('File exceeds 16,000 characters. Attach a smaller selection.');
    content = document?.getText() ?? content;
    return { content };
  } finally { await handle.close(); }
}
async function git(args: string[], root: string): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['--no-pager', ...args], { cwd: root, shell: false, timeout: 10000,
    maxBuffer: referenceLimits.gitBytes, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => {
    if (error) reject(new ContextError('Git context unavailable or too large. Use a workspace repository with HEAD and a smaller text diff.'));
    else resolve(stdout);
  }));
}
export async function gitReference(): Promise<NxReference> {
  if (!contextAvailable()) return fail('Context requires a trusted single local workspace.');
  const root = workspaceFolder().uri.fsPath;
  if (await fs.realpath((await git(['rev-parse', '--show-toplevel'], root)).trim()) !== await fs.realpath(root)) return fail('Git diff requires the repository root to be the current workspace.');
  // NUL-delimited paths are validated before obtaining a patch; no outside/symlink targets.
  const names = (await git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--no-renames', 'HEAD', '--', '.'], root)).split('\0').filter(Boolean);
  if (!names.length) return fail('No tracked changes relative to HEAD. Untracked files are not included.');
  for (const name of names) {
    if (!referenceDescriptor({ kind: 'file', path: name })) return fail('Git contains an unsupported path.');
    await resolveWorkspacePath(name, false);
  }
  const stats = (await git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--no-renames', 'HEAD', '--', '.'], root)).split('\0');
  if (stats.some(row => row.startsWith('-\t-\t'))) return fail('Git diff includes binary files. Attach individual text files instead.');
  const content = await git(['-c', 'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', '--', '.'], root);
  const ref: NxReference = { descriptor: { kind: 'git_diff', count: names.length }, provenance: 'git_diff', content };
  validateReferences([ref]); return ref;
}
export async function diagnosticsReference(): Promise<NxReference> {
  if (!contextAvailable()) return fail('Context requires a trusted single local workspace.');
  const rows: object[] = []; let omitted = 0, chars = 2;
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    let identity: string;
    try { identity = contextPath(uri); await resolveWorkspacePath(identity, true); } catch { continue; }
    for (const diagnostic of diagnostics) {
      const clean = (value: string, max: number) => value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"']+/g, '[path]').slice(0, max);
      const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
      const row = { path: identity, severity: ['error', 'warning', 'information', 'hint'][diagnostic.severity] ?? 'information',
        source: clean(diagnostic.source ?? '', referenceLimits.diagnosticField), code: typeof code === 'string' || typeof code === 'number' ? clean(String(code), referenceLimits.diagnosticField) : undefined,
        startLine: diagnostic.range.start.line + 1, startCharacter: diagnostic.range.start.character, endLine: diagnostic.range.end.line + 1, endCharacter: diagnostic.range.end.character,
        message: clean(diagnostic.message, referenceLimits.diagnosticMessage), messageTruncated: diagnostic.message.length > referenceLimits.diagnosticMessage };
      const size = JSON.stringify(row).length + 1;
      if (rows.length >= referenceLimits.diagnostics || chars + size > referenceLimits.individual - 200) { omitted++; continue; }
      rows.push(row); chars += size;
    }
  }
  if (!rows.length) return fail('No workspace diagnostics are available.');
  return { descriptor: { kind: 'diagnostics', count: rows.length, ...(omitted ? { omitted } : {}) }, provenance: 'diagnostics',
    content: JSON.stringify({ items: rows, omitted, incomplete: omitted > 0 }) };
}
export interface ContextPicker { choose(): Promise<string | undefined>; files(): Promise<vscode.Uri[] | undefined>; editor(): vscode.TextEditor | undefined }
export class ContextSources {
  constructor(private readonly picker: ContextPicker = {
    choose: async () => vscode.window.showQuickPick([...contextKinds], { title: 'Add Context', placeHolder: 'Select explicit context for the next message' }),
    files: async () => vscode.window.showOpenDialog({ title: 'Attach text files or PNG/JPEG images (including outside workspace)', defaultUri: workspaceFolder().uri, canSelectMany: true, canSelectFiles: true, canSelectFolders: false }),
    editor: () => vscode.window.activeTextEditor
  }) {}
  async pick(): Promise<Omit<DraftReference, 'id'>[]> {
    if (!contextAvailable()) return fail('Context requires a trusted single local workspace.');
    const choice = await this.picker.choose();
    if (!choice) return [];
    if (!(contextKinds as readonly string[]).includes(choice)) return fail('Unsupported context kind.');
    if (choice === 'Diagnostics' || choice === 'Git diff') {
      const reference = choice === 'Diagnostics' ? await diagnosticsReference() : await gitReference();
      return [{ descriptor: referenceDescriptor(reference.descriptor)!, provenance: reference.provenance }];
    }
    if (choice === 'Files...') {
      const uris = await this.picker.files();
      if (!uris) return [];
      if (uris.length > referenceLimits.count) return fail('Attach at most 8 context items.');
      const result: Omit<DraftReference, 'id'>[] = [];
      for (const uri of uris) {
        if (uri.scheme !== 'file' || uri.authority) return fail('Choose a local file.');
        const canonical = await fs.realpath(uri.fsPath), stat = await fs.stat(canonical);
        const selectedFile = { path: uri.fsPath, canonical, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
        const loaded = await selectedContents(selectedFile);
        let identity: string, external = false;
        try { identity = contextPath(uri); await resolveWorkspacePath(identity, true); } catch { identity = path.basename(uri.fsPath); external = true; }
        const descriptor = referenceDescriptor({ kind: loaded.image ? 'image' : 'file', path: identity, ...(external ? { scope: 'external' } : {}) });
        if (!descriptor) return fail('Unsupported file name. Rename the file and attach again.');
        validateReferences([{ descriptor, provenance: 'files_picker', ...loaded }]);
        result.push({ descriptor, provenance: 'files_picker', selectedFile });
      }
      return result;
    }
    const editor = this.picker.editor();
    if (!editor || editor.document.isUntitled) return fail('Open a supported workspace text editor first.');
    const identity = contextPath(editor.document.uri);
    if (choice === 'Current selection') {
      if (editor.selection.isEmpty) return fail('Select some text in the workspace editor first.');
      const range = editor.selection;
      const descriptor: NxReferenceDescriptor = { kind: 'selection', path: identity, startLine: range.start.line + 1, startCharacter: range.start.character,
        endLine: range.end.line + 1, endCharacter: range.end.character };
      if (editor.document.offsetAt(range.end) - editor.document.offsetAt(range.start) > referenceLimits.individual) return fail('Selection exceeds 16,000 characters. Select less text.');
      const snapshot = editor.document.getText(range);
      validateReferences([{ descriptor, provenance: 'current_selection', content: snapshot }]);
      await resolveWorkspacePath(identity, true);
      return [{ descriptor, provenance: 'current_selection', snapshot }];
    }
    const descriptor: NxReferenceDescriptor = { kind: 'file', path: identity };
    validateReferences([{ descriptor, provenance: 'current_file', content: await textFile(identity) }]);
    return [{ descriptor, provenance: 'current_file' }];
  }
  async materialize(drafts: readonly DraftReference[]): Promise<NxReference[]> {
    if (!drafts.length) return [];
    if (drafts.length > referenceLimits.count) return fail('Attach at most 8 context items.');
    if (!contextAvailable()) return fail('Context requires a trusted single local workspace.');
    const refs: NxReference[] = [];
    for (const draft of drafts) {
      const descriptor = referenceDescriptor(draft.descriptor);
      if (!descriptor) return fail('Invalid context. Remove it and attach again.');
      if (draft.selectedFile && draft.provenance === 'files_picker') {
        const loaded = await selectedContents(draft.selectedFile);
        if ((descriptor.kind === 'image') !== !!loaded.image) return fail('File type changed. Remove it and attach again.');
        refs.push({ descriptor, provenance: draft.provenance, ...loaded });
      } else if (descriptor.kind === 'image' || descriptor.scope === 'external') return fail('File permission expired. Attach it again with Files.');
      else if (descriptor.kind === 'diagnostics') refs.push(await diagnosticsReference());
      else if (descriptor.kind === 'git_diff') refs.push(await gitReference());
      else {
        await resolveWorkspacePath(descriptor.path!, true);
        const content = descriptor.kind === 'selection' ? draft.snapshot : await textFile(descriptor.path!);
        if (content === undefined) return fail('Selection snapshot unavailable. Attach it again.');
        refs.push({ descriptor, provenance: draft.provenance, content });
      }
    }
    refs.forEach((ref, index) => { if (drafts[index].crossProvider) ref.crossProvider = { ...drafts[index].crossProvider! }; });
    validateReferences(refs); return refs;
  }
}
/** Native Chat file/location inputs use the same host normalization and budgets. */
export async function nativeReferences(references: readonly vscode.ChatPromptReference[]): Promise<NxReference[]> {
  if (references.length > referenceLimits.count) return fail('Attach at most 8 context items.');
  const drafts: DraftReference[] = [];
  const text: NxReference[] = [];
  for (const reference of references) {
    const value = reference.value;
    const uri = value instanceof vscode.Uri ? value : value instanceof vscode.Location ? value.uri : undefined;
    if (!uri) { if (typeof value === 'string') text.push({ descriptor: { kind: 'native_text' }, provenance: 'native_chat', content: value }); continue; }
    const identity = contextPath(uri);
    const descriptor: NxReferenceDescriptor = value instanceof vscode.Location && !value.range.isEmpty ? { kind: 'selection', path: identity,
      startLine: value.range.start.line + 1, startCharacter: value.range.start.character, endLine: value.range.end.line + 1, endCharacter: value.range.end.character } : { kind: 'file', path: identity };
    let snapshot: string | undefined;
    if (value instanceof vscode.Location && !value.range.isEmpty) {
      await resolveWorkspacePath(identity, true);
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.offsetAt(value.range.end) - document.offsetAt(value.range.start) > referenceLimits.individual) return fail('Selection exceeds 16,000 characters. Select less text.');
      snapshot = document.getText(value.range);
    }
    drafts.push({ id: String(drafts.length), descriptor, provenance: 'native_chat', snapshot });
  }
  const result = [...await new ContextSources().materialize(drafts), ...text];
  validateReferences(result); return result;
}
