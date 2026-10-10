import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { SidebarController } from './controller';

export function sidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(24).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.js'));
  const markdown = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'markdown.js'));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none';">
<link rel="stylesheet" href="${css}"><title>NX Router</title></head>
<body><header><h1 class="sr-only">NX Router</h1><div id="navigation"></div><button id="settings" type="button" class="icon-button" aria-label="Open NX Router Settings" title="NX Settings"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M19.39,8.94L19.83,10.34L21.78,9.92L21.78,14.08L19.83,13.66L19.39,15.06L19.39,15.06L18.71,16.36L20.39,17.45L17.45,20.39L16.36,18.71L15.06,19.39L15.06,19.39L13.66,19.83L14.08,21.78L9.92,21.78L10.34,19.83L8.94,19.39L8.94,19.39L7.64,18.71L6.55,20.39L3.61,17.45L5.29,16.36L4.61,15.06L4.61,15.06L4.17,13.66L2.22,14.08L2.22,9.92L4.17,10.34L4.61,8.94L4.61,8.94L5.29,7.64L3.61,6.55L6.55,3.61L7.64,5.29L8.94,4.61L8.94,4.61L10.34,4.17L9.92,2.22L14.08,2.22L13.66,4.17L15.06,4.61L15.06,4.61L16.36,5.29L17.45,3.61L20.39,6.55L18.71,7.64L19.39,8.94ZM12,8.5a3.5,3.5 0 1,0 0,7a3.5,3.5 0 1,0 0,-7Z"/></svg></button></header>
<main id="content" aria-busy="true"><p role="status">Checking provider…</p></main>
<footer id="workspace"></footer><script nonce="${nonce}" src="${markdown}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private viewSubscriptions: vscode.Disposable[] = [];
  private readonly subscription: vscode.Disposable;
  constructor(private readonly extensionUri: vscode.Uri, private readonly controller: SidebarController) {
    this.subscription = controller.onDidChange(state => {
      if (this.view?.visible) { void this.view.webview.postMessage({ type: 'state', state }); }
    });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.viewSubscriptions.forEach(item => item.dispose());
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = sidebarHtml(view.webview, this.extensionUri);
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage(async message => {
        try {
          const ok = await this.controller.receive(message);
          if (message?.type === 'chat/send') await view.webview.postMessage({ type: 'sendResult', sessionId: message.sessionId, requestId: message.requestId, ok });
          if (message?.type === 'clipboard/copy' && Number.isSafeInteger(message.requestId)) {
            await view.webview.postMessage({ type: 'copyResult', requestId: message.requestId, ok });
          }
        } catch {
          if (message?.type === 'clipboard/copy' && Number.isSafeInteger(message.requestId)) {
            await view.webview.postMessage({ type: 'copyResult', requestId: message.requestId, ok: false });
          }
        }
      }),
      view.onDidChangeVisibility(() => { if (view.visible) { void this.controller.refresh(); } }),
      view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } })
    ];
  }
  dispose(): void { this.subscription.dispose(); this.viewSubscriptions.forEach(item => item.dispose()); }
}
