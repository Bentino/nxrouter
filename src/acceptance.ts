import * as vscode from 'vscode';
import { SpikeProvider, workers } from './provider';
import { Route } from './route';

import { record } from './evidence';

export const autoId = 'spike-auto';

/** No session map: repeat route selection from the supplied message history. */
export class AutoProvider extends SpikeProvider {
  override provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
    return [...super.provideLanguageModelChatInformation(), {
      id: autoId, name: 'NX Auto (acceptance fixture)', family: 'nx-spike', version: '1',
      maxInputTokens: 64000, maxOutputTokens: 2048, capabilities: { toolCalling: true }
    }];
  }
  override async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
    if (model.id !== autoId) { return super.provideLanguageModelChatResponse(model, messages, options, progress, token); }
    let route: Route = 'LOW';
    // Fixture grammar only. Local formatting/attachment provenance must be runtime-tested.
    for (const message of [...messages].reverse()) {
      if (message.role !== vscode.LanguageModelChatMessageRole.User || message.content.some(p => p instanceof vscode.LanguageModelToolResultPart)) { continue; }
      const text = message.content.filter(p => p instanceof vscode.LanguageModelTextPart).map(p => p.value).join('\n');
      const match = text.match(/(?:^|\n)(?:Request: )?\/(low|medium|high)\b/i);
      if (match) { route = match[1].toUpperCase() as Route; break; }
    }
    const worker = super.provideLanguageModelChatInformation().find(m => m.id === workers[route])!;
    record({ event: 'route', worker: worker.id, messages: messages.length,
      results: messages.flatMap(m => m.content).filter(p => p instanceof vscode.LanguageModelToolResultPart).length,
      dataParts: messages.flatMap(m => m.content).filter(p => p instanceof vscode.LanguageModelDataPart).length,
      optionKeys: Object.keys(options), tools: options.tools?.map(t => t.name) });
    progress.report(new vscode.LanguageModelTextPart(`[NX Auto → ${worker.id}]\n`));
    // An in-process stub worker adapter preserves every message/part and option unchanged.
    // A real backend is explicitly out of scope.
    return super.provideLanguageModelChatResponse(worker, messages, options, progress, token);
  }
}
