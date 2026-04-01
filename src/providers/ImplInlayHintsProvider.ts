import * as vscode from 'vscode';

const IMPL_TARGET_KINDS = new Set([
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
]);

export class ImplInlayHintsProvider implements vscode.InlayHintsProvider {
  async provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): Promise<vscode.InlayHint[]> {
    const config = vscode.workspace.getConfiguration('smartReferences');
    if (!config.get<boolean>('enableImplInlayHints', true)) return [];

    let symbols: vscode.DocumentSymbol[] = [];
    try {
      const raw = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
      );
      if (Array.isArray(raw)) symbols = raw;
    } catch {
      return [];
    }

    const targets = this.collectTargets(symbols, range);
    const hints: vscode.InlayHint[] = [];

    const results = await Promise.allSettled(targets.map(async sym => {
      const pos = sym.selectionRange.start;
      const result = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeImplementationProvider',
        document.uri,
        pos,
      );
      const impls = Array.isArray(result) ? result : [];
      if (impls.length === 0) return undefined;

      const lineLen = document.lineAt(sym.range.start.line).text.length;
      const isInterface = sym.kind === vscode.SymbolKind.Interface;

      let label: string;
      if (isInterface) {
        label = `← ${impls.length} impl${impls.length !== 1 ? 's' : ''}`;
      } else {
        const names = await this.resolveSymbolNames(impls);
        if (names.length === 0) return undefined;
        label = `← impl ${names.join(', ')}`;
      }

      const hint = new vscode.InlayHint(
        new vscode.Position(sym.range.start.line, lineLen),
        [{
          value: label,
          command: {
            title: 'Go to Implementation',
            command: 'smartReferences.goToImplementation',
            arguments: [document.uri, pos, impls],
          },
        }],
        vscode.InlayHintKind.Parameter,
      );
      hint.paddingLeft = true;
      return hint;
    }));

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) hints.push(r.value);
    }

    return hints;
  }

  private collectTargets(
    symbols: vscode.DocumentSymbol[],
    range: vscode.Range,
  ): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    for (const sym of symbols) {
      if (sym.range.start.line > range.end.line) continue;
      if (sym.range.end.line < range.start.line) continue;
      if (IMPL_TARGET_KINDS.has(sym.kind)) {
        result.push(sym);
      }
      if (sym.children.length > 0) {
        result.push(...this.collectTargets(sym.children, range));
      }
    }
    return result;
  }

  private async resolveSymbolNames(locations: vscode.Location[]): Promise<string[]> {
    const names: string[] = [];
    const seen = new Set<string>();
    await Promise.all(locations.map(async loc => {
      try {
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const wordRange = doc.getWordRangeAtPosition(loc.range.start);
        if (wordRange) {
          const name = doc.getText(wordRange);
          if (!seen.has(name)) {
            seen.add(name);
            names.push(name);
          }
        }
      } catch { /* skip */ }
    }));
    return names.sort();
  }
}
