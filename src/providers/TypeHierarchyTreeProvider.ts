import * as vscode from 'vscode';
import * as path from 'path';
import { TestFileDetector } from '../analyzers/TestFileDetector';
import { runConcurrent } from '../core/concurrent';
import { MAX_CONCURRENT_LSP_REQUESTS } from '../core/constants';
import { makeCategoryUri } from './CategoryDecorationProvider';

// ── Classified implementation ───────────────────────────────────────────────

interface ClassifiedImpl {
  location: vscode.Location;
  lineText: string;
  symbolKind: vscode.SymbolKind | undefined;
  symbolName: string | undefined;
  isTest: boolean;
}

// ── Category definitions ────────────────────────────────────────────────────

interface ImplCategory {
  label: string;
  icon: string;
  match: (impl: ClassifiedImpl) => boolean;
}

const IMPL_CATEGORIES: ImplCategory[] = [
  { label: 'Class',     icon: 'symbol-class',     match: i => !i.isTest && i.symbolKind === vscode.SymbolKind.Class },
  { label: 'Interface', icon: 'symbol-interface', match: i => !i.isTest && i.symbolKind === vscode.SymbolKind.Interface },
  { label: 'Method',    icon: 'symbol-method',    match: i => !i.isTest && (i.symbolKind === vscode.SymbolKind.Method || i.symbolKind === vscode.SymbolKind.Constructor) },
  { label: 'Function',  icon: 'symbol-function',  match: i => !i.isTest && i.symbolKind === vscode.SymbolKind.Function },
  { label: 'Struct',    icon: 'symbol-struct',    match: i => !i.isTest && i.symbolKind === vscode.SymbolKind.Struct },
  { label: 'Enum',      icon: 'symbol-enum',      match: i => !i.isTest && i.symbolKind === vscode.SymbolKind.Enum },
  { label: 'Other',     icon: 'symbol-misc',      match: i => !i.isTest && i.symbolKind !== undefined
    && i.symbolKind !== vscode.SymbolKind.Class && i.symbolKind !== vscode.SymbolKind.Interface
    && i.symbolKind !== vscode.SymbolKind.Method && i.symbolKind !== vscode.SymbolKind.Constructor
    && i.symbolKind !== vscode.SymbolKind.Function && i.symbolKind !== vscode.SymbolKind.Struct
    && i.symbolKind !== vscode.SymbolKind.Enum },
  { label: 'Unresolved', icon: 'question',        match: i => !i.isTest && i.symbolKind === undefined },
  { label: 'Tests',      icon: 'beaker',          match: i => i.isTest },
];

// ── Tree node types ─────────────────────────────────────────────────────────

type ImplNode = CategoryNode | DirectoryNode | FileNode | ImplItem;

class CategoryNode extends vscode.TreeItem {
  constructor(
    public readonly impls: ClassifiedImpl[],
    label: string,
    icon: string,
  ) {
    super({ label, highlights: [[0, label.length]] }, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${impls.length}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.resourceUri = makeCategoryUri(label);
    this.contextValue = 'implCategoryNode';
  }
}

class DirectoryNode extends vscode.TreeItem {
  constructor(
    public readonly dirPath: string,
    public readonly impls: ClassifiedImpl[],
  ) {
    super(dirPath || '.', vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${impls.length}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'implDirectoryNode';
  }
}

class FileNode extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly impls: ClassifiedImpl[],
  ) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${impls.length}`;
    this.tooltip = uri.fsPath;
    this.resourceUri = uri;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = 'implFileNode';
  }
}

class ImplItem extends vscode.TreeItem {
  constructor(impl: ClassifiedImpl) {
    const line = impl.location.range.start.line + 1;
    const trimmed = impl.lineText.trimStart();
    const label = impl.symbolName
      ? `${impl.symbolName}  ${trimmed}`
      : (trimmed || `line ${line}`);
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = `:${line}`;
    this.tooltip = `${impl.location.uri.fsPath}:${line}`;
    this.command = {
      command: 'smartReferences.previewReference',
      title: 'Preview',
      arguments: [impl.location.uri, impl.location.range],
    };
    this.resourceUri = impl.location.uri;
    this.contextValue = 'implItem';
  }
}

// ── Provider ────────────────────────────────────────────────────────────────

const MAX_HISTORY = 20;

interface ImplHistoryEntry {
  symbolName: string;
  impls: ClassifiedImpl[];
}

export class TypeHierarchyTreeProvider
  implements vscode.TreeDataProvider<ImplNode>, vscode.Disposable
{
  private _onDidChangeTreeData = new vscode.EventEmitter<ImplNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private symbolName = '';
  private impls: ClassifiedImpl[] = [];
  private workspaceRoot?: string;
  private testDetector: TestFileDetector;

  private history: ImplHistoryEntry[] = [];
  private historyIndex = -1;

  constructor(testDetector: TestFileDetector) {
    this.testDetector = testDetector;
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async setResults(symbolName: string, locations: vscode.Location[]): Promise<void> {
    this.symbolName = symbolName;
    this.impls = locations.map(loc => ({
      location: loc,
      lineText: '',
      symbolKind: undefined,
      symbolName: undefined,
      isTest: this.testDetector.isTestFile(loc.uri),
    }));
    await Promise.all([this.loadLineTexts(), this.loadSymbolKinds()]);
    // Truncate forward history, push new entry
    this.history.splice(this.historyIndex + 1);
    this.history.push({ symbolName: this.symbolName, impls: this.impls });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this._onDidChangeTreeData.fire();
  }

  goBack(): void {
    if (!this.canGoBack()) return;
    this.historyIndex--;
    this.restoreFromHistory();
  }

  goForward(): void {
    if (!this.canGoForward()) return;
    this.historyIndex++;
    this.restoreFromHistory();
  }

  canGoBack(): boolean { return this.historyIndex > 0; }
  canGoForward(): boolean { return this.historyIndex < this.history.length - 1; }

  private restoreFromHistory(): void {
    const entry = this.history[this.historyIndex];
    this.symbolName = entry.symbolName;
    this.impls = entry.impls;
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.symbolName = '';
    this.impls = [];
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ImplNode): vscode.TreeItem { return element; }

  getChildren(element?: ImplNode): ImplNode[] {
    if (!element) {
      return this.buildCategories();
    }
    if (element instanceof CategoryNode) {
      return this.buildDirectoryNodes(element.impls);
    }
    if (element instanceof DirectoryNode) {
      return this.buildFileNodes(element.impls);
    }
    if (element instanceof FileNode) {
      return element.impls
        .sort((a, b) => a.location.range.start.line - b.location.range.start.line)
        .map(impl => new ImplItem(impl));
    }
    return [];
  }

  getSymbolLabel(): string {
    return this.symbolName
      ? `${this.symbolName} (${this.impls.length} implementations)`
      : '';
  }

  // ── Tree building ───────────────────────────────────────────────────────

  private buildCategories(): ImplNode[] {
    const nodes: ImplNode[] = [];
    for (const cat of IMPL_CATEGORIES) {
      let matched = this.impls.filter(cat.match);
      if (cat.label === 'Interface') {
        matched = matched.filter(i => this.isWorkspacePath(i.location.uri.fsPath));
      }
      if (matched.length > 0) {
        nodes.push(new CategoryNode(matched, cat.label, cat.icon));
      }
    }
    return nodes;
  }

  private getRelativeDir(fsPath: string): string {
    if (!this.workspaceRoot) return path.dirname(fsPath);
    return path.relative(this.workspaceRoot, path.dirname(fsPath)) || '.';
  }

  private isWorkspacePath(fsPath: string): boolean {
    if (!this.workspaceRoot) return false;
    return fsPath.startsWith(this.workspaceRoot + path.sep) || fsPath === this.workspaceRoot;
  }

  private buildDirectoryNodes(impls: ClassifiedImpl[]): ImplNode[] {
    const byDir = new Map<string, ClassifiedImpl[]>();
    for (const impl of impls) {
      const dir = this.getRelativeDir(impl.location.uri.fsPath);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(impl);
    }
    return Array.from(byDir.entries())
      .sort(([aDir, aImpls], [bDir, bImpls]) => {
        const aLocal = this.isWorkspacePath(aImpls[0].location.uri.fsPath);
        const bLocal = this.isWorkspacePath(bImpls[0].location.uri.fsPath);
        if (aLocal !== bLocal) return aLocal ? -1 : 1;
        return aDir.localeCompare(bDir);
      })
      .map(([dir, dirImpls]) => new DirectoryNode(dir, dirImpls));
  }

  private buildFileNodes(impls: ClassifiedImpl[]): FileNode[] {
    const byFile = new Map<string, ClassifiedImpl[]>();
    for (const impl of impls) {
      const key = impl.location.uri.toString();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(impl);
    }
    return Array.from(byFile.values())
      .sort((a, b) => {
        const aLocal = this.isWorkspacePath(a[0].location.uri.fsPath);
        const bLocal = this.isWorkspacePath(b[0].location.uri.fsPath);
        if (aLocal !== bLocal) return aLocal ? -1 : 1;
        return a[0].location.uri.fsPath.localeCompare(b[0].location.uri.fsPath);
      })
      .map(fileImpls => new FileNode(fileImpls[0].location.uri, fileImpls));
  }

  // ── Data loading ──────────────────────────────────────────────────────

  private async loadLineTexts(): Promise<void> {
    const byFile = new Map<string, ClassifiedImpl[]>();
    for (const impl of this.impls) {
      const key = impl.location.uri.toString();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(impl);
    }
    await Promise.all(
      Array.from(byFile.values()).map(async fileImpls => {
        try {
          const doc = await vscode.workspace.openTextDocument(fileImpls[0].location.uri);
          for (const impl of fileImpls) {
            impl.lineText = doc.lineAt(impl.location.range.start.line).text;
          }
        } catch { /* best-effort: file may be closed or unavailable */ }
      }),
    );
  }

  private async loadSymbolKinds(): Promise<void> {
    const byFile = new Map<string, ClassifiedImpl[]>();
    for (const impl of this.impls) {
      const key = impl.location.uri.toString();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(impl);
    }
    await runConcurrent(Array.from(byFile.values()), MAX_CONCURRENT_LSP_REQUESTS, async fileImpls => {
      try {
        const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          fileImpls[0].location.uri,
        );
        if (!Array.isArray(symbols)) return;
        for (const impl of fileImpls) {
          const found = findSymbolAt(symbols, impl.location.range.start);
          if (found) {
            impl.symbolKind = found.kind;
            impl.symbolName = found.name;
          }
        }
      } catch { /* best-effort: file may be closed or unavailable */ }
    });
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

function findSymbolAt(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position,
): vscode.DocumentSymbol | undefined {
  for (const sym of symbols) {
    if (sym.range.contains(position)) {
      const child = findSymbolAt(sym.children, position);
      return child || sym;
    }
  }
  return undefined;
}
