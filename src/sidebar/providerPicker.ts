import * as vscode from 'vscode';
export interface ProviderPicker {
  pick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions & { canPickMany?: false }): Promise<T | undefined>;
  many<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Promise<T[] | undefined>;
  confirm(message: string): Promise<boolean>;
}
export const nativeProviderPicker: ProviderPicker = {
  pick: async (items, options) => vscode.window.showQuickPick(items, options),
  many: async (items, options) => vscode.window.showQuickPick(items, { ...options, canPickMany: true }),
  confirm: async message => await vscode.window.showInformationMessage(message, { modal: true }, 'Carry selected context') === 'Carry selected context'
};
