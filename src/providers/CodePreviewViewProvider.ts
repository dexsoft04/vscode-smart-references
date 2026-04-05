import * as vscode from 'vscode';
import * as path from 'path';

export class CodePreviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'codePreviewView';

  private _view?: vscode.WebviewView;
  private _currentUri?: vscode.Uri;
  private _currentRange?: vscode.Range;
  private _debounceTimer?: ReturnType<typeof setTimeout>;

  private static readonly CONTEXT_LINES = 15;
  private static readonly DEBOUNCE_MS = 100;

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'openLine' && this._currentUri) {
        const line = Number(msg.line);
        const range = new vscode.Range(line, 0, line, 0);
        void vscode.window.showTextDocument(this._currentUri, {
          selection: range,
          preview: false,
          preserveFocus: false,
        });
      }
    });

    if (this._currentUri && this._currentRange) {
      void this._render(this._currentUri, this._currentRange);
    } else {
      webviewView.webview.html = this._emptyHtml();
    }
  }

  async updatePreview(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    this._currentUri = uri;
    this._currentRange = range;

    if (!this._view) return;

    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      void this._render(uri, range);
    }, CodePreviewViewProvider.DEBOUNCE_MS);
  }

  private async _render(uri: vscode.Uri, range: vscode.Range): Promise<void> {
    if (!this._view) return;

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const targetLine = range.start.line;
      const startLine = Math.max(0, targetLine - CodePreviewViewProvider.CONTEXT_LINES);
      const endLine = Math.min(doc.lineCount - 1, targetLine + CodePreviewViewProvider.CONTEXT_LINES);

      const lines: string[] = [];
      for (let i = startLine; i <= endLine; i++) {
        lines.push(doc.lineAt(i).text);
      }

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
      const relativePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
        : path.basename(uri.fsPath);

      const editorConfig = vscode.workspace.getConfiguration('editor');
      const tabSize = editorConfig.get<number>('tabSize', 4);

      this._view.webview.html = this._codeHtml(
        relativePath,
        lines,
        startLine,
        targetLine,
        tabSize,
      );
    } catch {
      this._view.webview.html = this._errorHtml(uri.fsPath);
    }
  }

  private _codeHtml(
    filePath: string,
    lines: string[],
    startLine: number,
    targetLine: number,
    tabSize: number,
  ): string {
    const maxLineNum = startLine + lines.length;
    const gutterWidth = String(maxLineNum).length;

    const rows = lines
      .map((text, i) => {
        const lineNum = startLine + i;
        const isTarget = lineNum === targetLine;
        const cls = isTarget ? 'line target' : 'line';
        const escaped = this._escapeHtml(text);
        const paddedNum = String(lineNum + 1).padStart(gutterWidth);
        return `<tr class="${cls}" data-line="${lineNum}"><td class="gutter">${paddedNum}</td><td class="code">${escaped || '&nbsp;'}</td></tr>`;
      })
      .join('\n');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, Consolas, 'Courier New', monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  line-height: 1.5;
  tab-size: ${tabSize};
}
.header {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  position: sticky;
  top: 0;
  background: var(--vscode-editor-background);
  z-index: 1;
}
.code-container {
  overflow-x: auto;
  overflow-y: auto;
}
table { border-collapse: collapse; width: 100%; }
tr.line { cursor: pointer; }
tr.line:hover td { background: var(--vscode-list-hoverBackground); }
tr.target td {
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
}
tr.target:hover td {
  background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
}
td.gutter {
  padding: 0 8px 0 4px;
  text-align: right;
  color: var(--vscode-editorLineNumber-foreground);
  user-select: none;
  white-space: nowrap;
  vertical-align: top;
}
td.code {
  padding: 0 8px 0 0;
  white-space: pre;
}
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
</style>
</head>
<body>
  <div class="header" title="${this._escapeHtml(filePath)}">${this._escapeHtml(filePath)}:${targetLine + 1}</div>
  <div class="code-container">
    <table class="code-table">${rows}</table>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('tr.line').forEach(row => {
      row.addEventListener('click', () => {
        vscode.postMessage({ type: 'openLine', line: row.dataset.line });
      });
    });
    const target = document.querySelector('tr.target');
    if (target) target.scrollIntoView({ block: 'center' });
  </script>
</body>
</html>`;
  }

  private _emptyHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body { background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); display: flex; align-items: center; justify-content: center; height: 100vh; font-size: 12px; margin: 0; }
</style></head><body><div>Select a reference to preview code</div></body></html>`;
  }

  private _errorHtml(filePath: string): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
body { background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); display: flex; align-items: center; justify-content: center; height: 100vh; font-size: 12px; margin: 0; }
</style></head><body><div>Cannot preview: ${this._escapeHtml(path.basename(filePath))}</div></body></html>`;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  dispose(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
  }
}
