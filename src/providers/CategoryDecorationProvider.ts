import * as vscode from 'vscode';

const CATEGORY_SCHEME = 'smart-ref-cat';

export function makeCategoryUri(label: string): vscode.Uri {
  return vscode.Uri.parse(`${CATEGORY_SCHEME}:${encodeURIComponent(label)}`);
}

export class CategoryDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CATEGORY_SCHEME) return undefined;
    return {
      color: new vscode.ThemeColor('smartReferences.categoryForeground'),
    };
  }
}
