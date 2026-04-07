import * as vscode from 'vscode';
import { TranslationManager } from '../providers/TranslationManager';

export interface TranslationCommandsDeps {
  outputChannel: vscode.OutputChannel;
}

export function registerTranslationCommands(deps: TranslationCommandsDeps): {
  disposables: vscode.Disposable[];
  translationMgr: TranslationManager;
} {
  const translationMgr = new TranslationManager(deps.outputChannel);
  const translationDocProvider = vscode.workspace.registerTextDocumentContentProvider(
    'translation-view',
    translationMgr,
  );
  const translationHoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    translationMgr,
  );
  const translateCmd = vscode.commands.registerCommand(
    'smartReferences.translate',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active editor for translation.');
        return;
      }
      translationMgr.executeTranslate(editor);
    },
  );

  return {
    disposables: [
      translationMgr,
      translationDocProvider,
      translationHoverProvider,
      translateCmd,
    ],
    translationMgr,
  };
}
