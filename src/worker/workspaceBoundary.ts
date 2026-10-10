import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export function workspaceFolder(): vscode.WorkspaceFolder {
  if (!vscode.workspace.isTrusted) { throw new Error('Trusted workspace required.'); }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length || folders.length !== 1 || folders[0].uri.scheme !== 'file') { throw new Error('Exactly one local workspace root is required.'); }
  return folders[0];
}
export async function resolveWorkspacePath(input: string, exists: boolean, directory = false): Promise<vscode.Uri> {
  if (typeof input === 'string' && input.trim() !== input) { throw new Error('Invalid workspace-relative path: remove leading/trailing whitespace.'); }
  if (typeof input !== 'string' || !input || input.length > 500 || /[\x00-\x1f]/.test(input) || input.includes('\\') || input.includes('://') || path.isAbsolute(input)) { throw new Error('Invalid workspace-relative path.'); }
  const root = workspaceFolder().uri.fsPath;
  const target = path.resolve(root, input);
  if (target === root || !target.startsWith(root + path.sep)) { throw new Error('Path escapes workspace or targets root.'); }
  const realRoot = await fs.realpath(root);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const real = await fs.realpath(current);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) { throw new Error('Symlink escapes workspace.'); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
      if (exists) { throw new Error('Workspace target does not exist.'); }
      break;
    }
  }
  if (exists) {
    const stat = await fs.stat(target);
    if (directory ? !stat.isDirectory() : !stat.isFile()) { throw new Error(directory ? 'Expected directory.' : 'Expected file.'); }
  }
  return vscode.Uri.file(target);
}
export function relativePath(uri: vscode.Uri): string { return path.relative(workspaceFolder().uri.fsPath, uri.fsPath).replaceAll(path.sep, '/'); }
