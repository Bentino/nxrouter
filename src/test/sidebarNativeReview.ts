import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';

/** Run only in the disposable production-contribution host driven by test-native-review.cjs. */
export async function run(): Promise<void> {
  await vscode.extensions.getExtension('nx-router.nx-router')!.activate();
  const name = 'ui03-disposable.txt';
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, name);
  const source = new vscode.CancellationTokenSource();
  const parse = (result: vscode.LanguageModelToolResult) => JSON.parse(result.content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join(''));
  try {
    const created = parse(await vscode.lm.invokeTool('nx_create_file', { toolInvocationToken: undefined, input: { path: name, content: 'Reviewed production tool fixture\n' } }, source.token));
    assert.equal(created.success, true, JSON.stringify(created));
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), 'Reviewed production tool fixture\n');
    const diffDocuments = vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'nx-router-diff');
    assert.ok(diffDocuments.some(document => document.getText() === 'Reviewed production tool fixture\n'), 'Native diff must load actual proposed text');
    // A second exact review is cancelled; the original file must stay intact.
    const rejected = parse(await vscode.lm.invokeTool('nx_edit_file', { toolInvocationToken: undefined,
      input: { path: name, edits: [{ range: { startLine: 1, startCharacter: 0, endLine: 2, endCharacter: 0 }, expectedText: 'Reviewed production tool fixture\n', text: 'Should never be applied\n' }] } }, source.token));
    assert.equal(rejected.success, false);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), 'Reviewed production tool fixture\n');
    const editedText = 'Edited disposable production fixture\n';
    const edited = parse(await vscode.lm.invokeTool('nx_edit_file', { toolInvocationToken: undefined,
      input: { path: name, edits: [{ range: { startLine: 1, startCharacter: 0, endLine: 2, endCharacter: 0 }, expectedText: 'Reviewed production tool fixture\n', text: editedText }] } }, source.token));
    assert.equal(edited.success, true); assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), editedText);
    const copied = parse(await vscode.lm.invokeTool('nx_copy_file', { toolInvocationToken: undefined, input: { source: name, destination: 'ui08-copy.txt' } }, source.token));
    assert.equal(copied.success, true);
    const moved = parse(await vscode.lm.invokeTool('nx_move_file', { toolInvocationToken: undefined, input: { source: 'ui08-copy.txt', destination: 'ui08-moved.txt' } }, source.token));
    assert.equal(moved.success, true);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'ui08-moved.txt'))).toString(), editedText);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'package.json'), Buffer.from(JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } })));
    const executed = parse(await vscode.lm.invokeTool('nx_execute', { toolInvocationToken: undefined, input: { command: 'npm', args: ['test'] } }, source.token));
    assert.equal(executed.success, true); assert.equal(executed.structuredData.exitCode, 0);
    const denied = parse(await vscode.lm.invokeTool('nx_execute', { toolInvocationToken: undefined, input: { command: 'rm', args: ['-rf', 'ui08-moved.txt'] } }, source.token));
    assert.equal(denied.rejected, true); assert.equal(denied.errorCode, 'POLICY_REJECTED');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'ui08-moved.txt'))).toString(), editedText);
    await fs.writeFile(process.env.NX_NATIVE_REVIEW_RESULTS!, JSON.stringify({ status: 'passed',
      checks: ['production tools with undefined Chat token', 'native WRITE confirmation', 'real native diff content', 'Apply creates disposable file', 'Cancel preserves original file', 'Apply edits disposable file', 'native Copy and Move', 'native EXECUTE npm test exit zero', 'dangerous command policy denied; target unchanged'] }));
  } finally { source.dispose(); await vscode.workspace.fs.delete(uri, { useTrash: false }).then(() => {}, () => {}); }
}
