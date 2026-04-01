import * as vscode from 'vscode';
import { CSharpWorkspaceTypeIndexer } from '../core/CSharpWorkspaceTypeIndexer';
import { DepSymbolIndexer } from '../core/GoDepSymbolIndexer';

// ── C# Definition Provider ────────────────────────────────────────────────────
// Provides Go-to-Definition (F12 / Ctrl+Click) for C# type names when no
// dedicated language server is available (e.g. bare Unity projects).
//
// Looks up the word at the cursor in two sources, in order:
//   1. Workspace type index  – class/interface/struct/enum/record declarations
//      in all .cs files under the workspace root.
//   2. Dependency symbol index – types indexed from NuGet / Unity packages.
//
// Results stack with OmniSharp / C# Dev Kit: if a language server is present
// its results appear alongside ours; users just see more choices.

export class CSharpDefinitionProvider implements vscode.DefinitionProvider, vscode.Disposable {
  private readonly log: vscode.OutputChannel;
  private readonly wsIndexer: CSharpWorkspaceTypeIndexer;
  private readonly depIndexer: DepSymbolIndexer;

  // Cached flattened dep map so we don't re-iterate symbols on every keystroke.
  private depMapPromise: Promise<Map<string, vscode.Location>> | undefined;

  constructor(
    log: vscode.OutputChannel,
    wsIndexer: CSharpWorkspaceTypeIndexer,
    depIndexer: DepSymbolIndexer,
  ) {
    this.log = log;
    this.wsIndexer = wsIndexer;
    this.depIndexer = depIndexer;
  }

  /** Call when the dep index has been invalidated externally. */
  invalidateDepCache(): void {
    this.depMapPromise = undefined;
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location | undefined> {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);
    // Skip obviously non-type identifiers (lowercase-first = local variable / keyword)
    if (!word || word[0] !== word[0].toUpperCase() || word[0] === word[0].toLowerCase()) {
      return undefined;
    }

    if (token.isCancellationRequested) return undefined;

    const [wsIndex, depMap] = await Promise.all([
      this.wsIndexer.getIndex(),
      this.getDepMap(),
    ]);

    if (token.isCancellationRequested) return undefined;

    return wsIndex.get(word) ?? depMap.get(word);
  }

  private getDepMap(): Promise<Map<string, vscode.Location>> {
    if (!this.depMapPromise) {
      this.depMapPromise = this.buildDepMap();
    }
    return this.depMapPromise;
  }

  private async buildDepMap(): Promise<Map<string, vscode.Location>> {
    const map = new Map<string, vscode.Location>();
    const syms = await this.depIndexer.getSymbols();
    for (const sym of syms) {
      if (!map.has(sym.name)) map.set(sym.name, sym.location);
    }
    this.log.appendLine(`[cs-def] dep map: ${map.size} types`);
    return map;
  }

  dispose(): void { /* nothing to clean up */ }
}
