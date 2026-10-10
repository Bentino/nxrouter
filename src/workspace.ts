import * as vscode from 'vscode';

export const expected = 'NX Router native spike verified.\n';
export const fixtureDirectory = '.nx-router-spike';

export function workspaceRoot(): vscode.Uri {
  if (!vscode.workspace.isTrusted) { throw new Error('A trusted workspace is required.'); }
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root || root.scheme !== 'file') { throw new Error('Open a local workspace folder for this spike.'); }
  return root;
}

async function statOrMissing(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try { return await vscode.workspace.fs.stat(uri); }
  catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return undefined; }
    throw error;
  }
}

export async function fixture(): Promise<vscode.Uri> {
  const root = workspaceRoot();
  // Reject symlinks and unexpected types in the fixed fixture path.
  const directory = vscode.Uri.joinPath(root, fixtureDirectory);
  const uri = vscode.Uri.joinPath(directory, 'example.txt');
  for (const [target, type] of [[directory, vscode.FileType.Directory], [uri, vscode.FileType.File]] as const) {
    const stat = await statOrMissing(target);
    if (stat && stat.type !== type) { throw new Error(`Unsafe fixture path: ${target.fsPath}`); }
  }
  return uri;
}

export async function readFixture(): Promise<string> {
  const uri = await fixture();
  if (!await statOrMissing(uri)) { return '(Demo file does not exist yet. Ask for write.)'; }
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.getText().length > 16000) { throw new Error('Fixture exceeds spike size limit.'); }
  return doc.getText();
}

export class DiffContent implements vscode.TextDocumentContentProvider {
  private readonly snapshots = new Map<string, string>();
  set(name: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: 'nx-router-diff', path: `/${Date.now()}-${Math.random()}/${name}` });
    this.snapshots.set(uri.toString(), text);
    return uri;
  }
  provideTextDocumentContent(uri: vscode.Uri): string { return this.snapshots.get(uri.toString()) ?? ''; }
  release(uri: vscode.Uri): void { this.snapshots.delete(uri.toString()); }
}

export async function proposeWrite(content: DiffContent, token: vscode.CancellationToken): Promise<string> {
  const uri = await fixture();
  const exists = !!await statOrMissing(uri);
  const document = exists ? await vscode.workspace.openTextDocument(uri) : undefined;
  if (document?.isDirty) { throw new Error('Save or discard the dirty demo file before the spike.'); }
  const before = document?.getText() ?? '';
  const version = document?.version;
  const left = content.set('before.txt', before);
  const right = content.set('proposed.txt', expected);
  try {
    await vscode.commands.executeCommand('vscode.diff', left, right, 'NX Spike: review proposed change');
    const choice = await vscode.window.showInformationMessage(
      'Review the native diff. Apply this fixed demo change?', { modal: true }, 'Apply');
    if (choice !== 'Apply' || token.isCancellationRequested) { return 'Write rejected or cancelled; no changes applied.'; }
    await fixture();
    if (exists !== !!await statOrMissing(uri) || (document && (document.version !== version || document.isDirty))) {
      throw new Error('Demo file changed during review. Request a fresh diff.');
    }
    const edit = new vscode.WorkspaceEdit();
    if (!exists) { edit.createFile(uri, { overwrite: false }); }
    edit.replace(uri, new vscode.Range(0, 0, document?.lineCount ?? 0, 0), expected);
    if (!await vscode.workspace.applyEdit(edit)) { throw new Error('WorkspaceEdit was rejected.'); }
    const updated = await vscode.workspace.openTextDocument(uri);
    if (!await updated.save()) { throw new Error('Demo file could not be saved.'); }
    return `Applied and saved ${vscode.workspace.asRelativePath(uri)} using WorkspaceEdit.`;
  } finally {
    // Virtual documents retain their loaded text; drop backing snapshots after review.
    content.release(left); content.release(right);
  }
}

export async function verifyFixture(token: vscode.CancellationToken, testDelayMs = 0): Promise<string> {
  const uri = await fixture();
  if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
  // A fixed executable and argument vector: model input can never become shell source.
  if (![0, 10000].includes(testDelayMs)) { throw new Error('Unsupported fixture delay.'); }
  const script = `const fs=require('node:fs');const assert=require('node:assert/strict');assert.equal(fs.readFileSync(process.argv[1],'utf8'),${JSON.stringify(expected)});console.log('NX_SPIKE_VERIFY_OK');${testDelayMs ? 'setTimeout(() => {}, 10000);' : ''}`;
  const task = new vscode.Task({ type: 'nx-spike' }, vscode.workspace.workspaceFolders![0],
    'NX Spike verification', 'NX Router', new vscode.ProcessExecution('node', ['-e', script, uri.fsPath]));
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated };
  return new Promise<string>((resolve, reject) => {
    let execution: vscode.TaskExecution | undefined;
    let finished = false;
    const cleanup = () => { finished = true; clearTimeout(timer); ended.dispose(); taskEnded.dispose(); cancelled.dispose(); };
    const ended = vscode.tasks.onDidEndTaskProcess(event => {
      if (event.execution !== execution) { return; }
      cleanup();
      resolve(`Native Task exited with code ${event.exitCode ?? 'unknown'}. Output is in the NX Spike verification terminal.`);
    });
    const taskEnded = vscode.tasks.onDidEndTask(event => {
      if (event.execution !== execution || finished) { return; }
      cleanup(); resolve('Native Task ended without a process exit code (stopped or failed to launch).');
    });
    const cancelled = token.onCancellationRequested(() => {
      execution?.terminate(); cleanup(); reject(new vscode.CancellationError());
    });
    const timer = setTimeout(() => {
      execution?.terminate(); cleanup(); reject(new Error('Verification timed out after 30 seconds.'));
    }, 30000);
    vscode.tasks.executeTask(task).then(value => {
      execution = value;
      if (finished || token.isCancellationRequested) { value.terminate(); }
    }, error => { cleanup(); reject(error); });
  });
}
