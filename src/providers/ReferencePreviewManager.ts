import * as vscode from 'vscode';

export class ReferencePreviewManager implements vscode.Disposable {
  // Persistent decoration — one highlighted line at a time
  private readonly lineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });

  async preview(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: column,
      preview: true,
      preserveFocus: true,
      selection: range,
    });

    // Scroll the reference line to center
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    // Clear previous highlight on all visible editors, then apply to this one
    for (const e of vscode.window.visibleTextEditors) {
      e.setDecorations(this.lineDecoration, []);
    }
    editor.setDecorations(this.lineDecoration, [range]);
  }

  dispose(): void {
    this.lineDecoration.dispose();
  }
}
