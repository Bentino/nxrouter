import * as vscode from 'vscode';
import { DiffContent, proposeWrite, readFixture, verifyFixture } from './workspace';

export interface ToolInput { operation: 'read' | 'write' | 'verify' }
export class WorkspaceTool implements vscode.LanguageModelTool<ToolInput> {
  constructor(private readonly diff: DiffContent) {}
  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ToolInput>): vscode.PreparedToolInvocation {
    const op = options.input.operation;
    return {
      invocationMessage: `NX spike: ${op}`,
      ...(op === 'read' ? {} : { confirmationMessages: {
        title: op === 'write' ? 'Review demo file write' : 'Run fixed verification command',
        message: op === 'write'
          ? 'Propose fixed content for .nx-router-spike/example.txt. A native diff and Apply prompt follow; existing content will be replaced only after Apply.'
          : 'Run node with a fixed assertion against .nx-router-spike/example.txt via VS Code Tasks. No workspace script or model-supplied command is executed.'
      } })
    };
  }
  async invoke(options: vscode.LanguageModelToolInvocationOptions<ToolInput>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    let result: string;
    switch (options.input.operation) {
      case 'read': result = await readFixture(); break;
      case 'write': result = await proposeWrite(this.diff, token); break;
      case 'verify': result = await verifyFixture(token); break;
      default: throw new Error('Unknown spike operation.');
    }
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result)]);
  }
}

/** Separate IDs cannot accept another operation via model-controlled input. */
export class IsolatedTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private readonly diff: DiffContent, private readonly operation: ToolInput['operation'] | 'dangerous') {}
  prepareInvocation(): vscode.PreparedToolInvocation {
    if (this.operation !== 'dangerous') {
      return new WorkspaceTool(this.diff).prepareInvocation({ input: { operation: this.operation } });
    }
    return { invocationMessage: 'NX harmless dangerous-operation simulation', confirmationMessages: {
      title: 'Approve DANGEROUS simulation', message: 'Returns NX_SPIKE_DANGEROUS_SIMULATED only. No files, commands, or external systems are changed.'
    } };
  }
  async invoke(options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (Object.keys(options.input).length) { throw new Error('Isolated tools accept no operation override.'); }
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    if (this.operation === 'dangerous') {
      // Native session/global auto-approval must not be the sole mandatory boundary.
      const answer = await vscode.window.showWarningMessage('NX DANGEROUS simulation: approve this invocation?', { modal: true }, 'Simulate');
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(
        answer === 'Simulate' && !token.isCancellationRequested ? 'NX_SPIKE_DANGEROUS_SIMULATED' : 'DANGEROUS simulation rejected; nothing performed.')]);
    }
    return new WorkspaceTool(this.diff).invoke({ ...options, input: { operation: this.operation } }, token);
  }
}
