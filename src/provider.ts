import * as vscode from 'vscode';
import { isolatedTools, record } from './evidence';

import { Route } from './route';
export type { Route } from './route';
// Deliberately a stub mapping. No OpenAI names in workspace or chat operations.
export const workers: Record<Route, string> = { LOW: 'spike-low', MEDIUM: 'spike-medium', HIGH: 'spike-high' };

/** Offline protocol fixture, not an LLM, router, or general coding worker. */
export class SpikeProvider implements vscode.LanguageModelChatProvider {
  provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
    return Object.entries(workers).map(([route, id]) => ({
      id, name: `NX Spike ${route}`, family: 'nx-spike', version: '1',
      maxInputTokens: 64000, maxOutputTokens: 2048,
      capabilities: { toolCalling: true }, detail: 'Offline deterministic API test'
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
    record({ event: 'worker', worker: model.id, messages: messages.length,
      attachmentSentinel: messages.some(m => m.content.some(p => p instanceof vscode.LanguageModelTextPart && p.value.includes('ATTACHMENT_SENTINEL'))),
      resultCallIds: messages.flatMap(m => m.content).filter(p => p instanceof vscode.LanguageModelToolResultPart).map(p => p.callId) });
    const last = messages.at(-1);
    const results = last?.content.filter(p => p instanceof vscode.LanguageModelToolResultPart) ?? [];
    const escalationFixture = messages.some(m => m.content.some(p => p instanceof vscode.LanguageModelTextPart && p.value.includes('nx-escalation-fixture')));
    if (escalationFixture) {
      const route = model.id === workers.HIGH ? 'HIGH' : 'MEDIUM';
      if (results.length) { progress.report(new vscode.LanguageModelTextPart(`${route} fixture completed after production SAFE read.`)); return; }
      const target = route === 'HIGH' ? 'escalation-fixture/high.txt' : 'escalation-fixture/architecture.txt';
      progress.report(new vscode.LanguageModelToolCallPart(`escalation-${Date.now()}`, 'nx_read', { path: target }));
      return;
    }
    if (results.length) {
      progress.report(new vscode.LanguageModelTextPart('Tool result received in this session:\n\n'));
      for (const result of results) {
        for (const part of result.content) {
          if (part instanceof vscode.LanguageModelTextPart) { progress.report(part); }
        }
      }
      return;
    }
    const text = last?.content.filter(p => p instanceof vscode.LanguageModelTextPart).map(p => p.value).join('\n') ?? '';
    const prompt = text.includes('\nRequest: ') ? text.slice(text.lastIndexOf('\nRequest: ') + 10) : text.replace(/^Request: /, '');
    if (/\bwait\b/i.test(prompt)) {
      progress.report(new vscode.LanguageModelTextPart('Cancellation fixture waiting (30 seconds).'));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { listener.dispose(); resolve(); }, 30000);
        const listener = token.onCancellationRequested(() => {
          clearTimeout(timer); listener.dispose(); record({ event: 'provider-cancelled', worker: model.id }); reject(new vscode.CancellationError());
        });
        if (token.isCancellationRequested) { clearTimeout(timer); listener.dispose(); reject(new vscode.CancellationError()); }
      });
      return;
    }
    const operation = /\bdangerous\b/i.test(prompt) ? 'dangerous' : /\bverify\b/i.test(prompt) ? 'verify' : /\bwrite\b/i.test(prompt) ? 'write' : 'read';
    const tool = options.tools?.find(t => t.name === isolatedTools[operation]) ?? (operation !== 'dangerous' ? options.tools?.find(t => t.name === 'nx_spike_workspace') : undefined);
    progress.report(new vscode.LanguageModelTextPart(`[${model.name}; scripted fixture] ${operation}\n\n`));
    if (tool) {
      progress.report(new vscode.LanguageModelToolCallPart(`nx-${Date.now()}`, tool.name, tool.name === 'nx_spike_workspace' ? { operation } : {}));
    } else {
      progress.report(new vscode.LanguageModelTextPart('No NX workspace tool offered. Text streaming probe complete.'));
    }
  }

  async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    // Only a conservative estimate for this offline fixture. Real providers need a tokenizer.
    return (typeof text === 'string' ? text : JSON.stringify(text)).length;
  }
}
