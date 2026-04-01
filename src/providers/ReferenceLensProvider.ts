import * as vscode from 'vscode';
import { TestFileDetector } from '../analyzers/TestFileDetector';

export class ReferenceLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private testDetector: TestFileDetector) {}

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration('smartReferences');
    if (!config.get<boolean>('enableCodeLens', true)) return [];
    if (document.uri.fsPath.endsWith('.proto')) return [];

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

    const lenses: vscode.CodeLens[] = [];
    for (const sym of this.flattenSymbols(symbols)) {
      if (!this.isCallable(sym)) continue;
      const pos = sym.selectionRange.start;
      lenses.push(new vscode.CodeLens(sym.selectionRange, {
        command: 'smartReferences.findReferencesAt',
        title: '$(references) loading...',
        arguments: [document.uri, pos],
      }));
      if (this.isImplTarget(sym)) {
        lenses.push(new vscode.CodeLens(sym.selectionRange, {
          command: 'smartReferences.goToImplementation',
          title: '$(symbol-interface) loading...',
          arguments: [document.uri, pos],
        }));
      }
    }
    return lenses;
  }

  async resolveCodeLens(lens: vscode.CodeLens): Promise<vscode.CodeLens> {
    if (!lens.command?.arguments) return lens;
    const [uri, pos] = lens.command.arguments as [vscode.Uri, vscode.Position];

    if (lens.command.command === 'smartReferences.goToImplementation') {
      return this.resolveImplLens(lens, uri, pos);
    }

    try {
      const refs = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        pos,
      );
      const count = Array.isArray(refs) ? refs.length : 0;
      if (count === 0) {
        lens.command.title = '$(references) 0 references';
      } else {
        const testCount = Array.isArray(refs)
          ? refs.filter(r => this.testDetector.isTestFile(r.uri)).length
          : 0;
        const parts: string[] = [`${count} reference${count !== 1 ? 's' : ''}`];
        if (testCount > 0) parts.push(`${testCount} test${testCount !== 1 ? 's' : ''}`);
        lens.command.title = `$(references) ${parts.join(' · ')}`;
      }
    } catch {
      lens.command.title = '$(references) references';
    }
    lens.command.command = 'smartReferences.findReferencesAt';
    lens.command.arguments = [uri, pos];
    return lens;
  }

  private async resolveImplLens(
    lens: vscode.CodeLens,
    uri: vscode.Uri,
    pos: vscode.Position,
  ): Promise<vscode.CodeLens> {
    if (!lens.command) return lens;
    try {
      const result = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeImplementationProvider',
        uri,
        pos,
      );
      const impls = Array.isArray(result) ? result : [];
      const count = impls.length;
      if (count === 0) {
        lens.command.title = '$(symbol-interface) 0 impls';
      } else {
        lens.command.title = `$(symbol-interface) ${count} impl${count !== 1 ? 's' : ''}`;
        lens.command.arguments = [uri, pos, impls];
      }
    } catch {
      lens.command.title = '$(symbol-interface) impls';
    }
    return lens;
  }

  refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }

  private flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    for (const sym of symbols) {
      result.push(sym);
      if (sym.children.length > 0) {
        result.push(...this.flattenSymbols(sym.children));
      }
    }
    return result;
  }

  private isCallable(sym: vscode.DocumentSymbol): boolean {
    return [
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Interface,
      vscode.SymbolKind.Constructor,
    ].includes(sym.kind);
  }

  private isImplTarget(sym: vscode.DocumentSymbol): boolean {
    return [
      vscode.SymbolKind.Interface,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Struct,
    ].includes(sym.kind);
  }
}
