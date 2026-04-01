import * as vscode from 'vscode';
import * as fs from 'fs';

// ── CSharpWorkspaceTypeIndexer ────────────────────────────────────────────────
// Indexes type declarations (class / interface / struct / enum / record /
// delegate) from all .cs files in the workspace.  Follows the same
// lazy-build + promise-cache pattern as GoDepSymbolIndexer.

const TYPE_DECL_RE =
  /^[^\S\n]*(?:[a-z]+\s+)*(?:class|interface|struct|enum|record|delegate)\s+([A-Za-z_]\w*)/;

export class CSharpWorkspaceTypeIndexer implements vscode.Disposable {
  private readonly log: vscode.OutputChannel;
  private indexPromise: Promise<Map<string, vscode.Location>> | undefined;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  invalidate(): void {
    this.indexPromise = undefined;
  }

  /** Returns a map of type name → declaration location. */
  getIndex(): Promise<Map<string, vscode.Location>> {
    if (!this.indexPromise) {
      this.indexPromise = this.build();
    }
    return this.indexPromise;
  }

  private async build(): Promise<Map<string, vscode.Location>> {
    const map = new Map<string, vscode.Location>();
    const t0 = Date.now();

    const csFiles = await vscode.workspace.findFiles(
      '**/*.cs',
      '{**/node_modules/**,**/bin/**,**/obj/**}',
      5000,
    );

    for (const uri of csFiles) {
      try {
        const lines = fs.readFileSync(uri.fsPath, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(TYPE_DECL_RE);
          if (m && !map.has(m[1])) {
            map.set(m[1], new vscode.Location(uri, new vscode.Position(i, 0)));
          }
        }
      } catch { /* ignore unreadable files */ }
    }

    this.log.appendLine(
      `[cs-ws-index] ${map.size} types from ${csFiles.length} files in ${Date.now() - t0}ms`,
    );
    return map;
  }

  dispose(): void { /* nothing to clean up */ }
}
