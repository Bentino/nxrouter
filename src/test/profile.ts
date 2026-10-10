import * as vscode from 'vscode';
export async function inspectProfile(): Promise<object> {
  let githubAccounts: number | string;
  try { githubAccounts = (await vscode.authentication.getAccounts('github')).length; }
  catch (error) { githubAccounts = String(error); }
  return {
    vscode: vscode.version, githubAccounts,
    copilotExtensions: vscode.extensions.all.filter(e => /copilot/i.test(e.id)).map(e => ({ id: e.id, active: e.isActive, version: e.packageJSON.version })),
    chatDisabled: vscode.workspace.getConfiguration('chat').get('disableAIFeatures'),
    trusted: vscode.workspace.isTrusted,
    note: 'Account count only; no credentials or account identities collected. This is not Local execution proof.'
  };
}
