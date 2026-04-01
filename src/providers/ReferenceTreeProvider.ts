import * as vscode from 'vscode';
import * as path from 'path';
import { ClassifiedReference, ReferenceCategory, CodeContext } from '../core/ReferenceTypes';
import { makeCategoryUri } from './CategoryDecorationProvider';
import { extractDocComment } from './StructureTreeProvider';

type TreeNode = CategoryGroupNode | DirectoryNode | FileNode | CallerNode | ReferenceItem;
export type ReferenceScopeFilter = 'all' | 'production' | 'test';

// ── Category group definition ─────────────────────────────────────────────────

interface CategoryGroup {
  label: string;
  icon: vscode.ThemeIcon;
  refs: ClassifiedReference[];
  color: string;
}

// Category display order and icons
const CATEGORY_DEFS: { label: string; icon: string; color: string; match: (r: ClassifiedReference) => boolean }[] = [
  { label: 'Definitions',        icon: 'symbol-interface', color: 'symbolIcon.interfaceForeground',  match: r => r.category === ReferenceCategory.Definition },
  { label: 'Implementations',    icon: 'symbol-class',     color: 'symbolIcon.classForeground',      match: r => r.category === ReferenceCategory.Implementation },
  { label: 'Proto',              icon: 'symbol-namespace', color: 'symbolIcon.namespaceForeground',  match: r => r.category === ReferenceCategory.Proto },
  { label: 'Imports',            icon: 'package',          color: 'symbolIcon.namespaceForeground',  match: r => r.category === ReferenceCategory.Import && r.context === CodeContext.Production },
  { label: 'Field declarations', icon: 'symbol-field',     color: 'symbolIcon.fieldForeground',      match: r => r.category === ReferenceCategory.FieldDeclaration && r.context === CodeContext.Production },
  { label: 'Parameter types',    icon: 'symbol-parameter', color: 'symbolIcon.parameterForeground',  match: r => r.category === ReferenceCategory.ParameterDeclaration && r.context === CodeContext.Production },
  { label: 'Return types',       icon: 'symbol-property',  color: 'symbolIcon.propertyForeground',   match: r => r.category === ReferenceCategory.ReturnType && r.context === CodeContext.Production },
  { label: 'Instantiations',     icon: 'add',              color: 'charts.green',                    match: r => r.category === ReferenceCategory.Instantiation && r.context === CodeContext.Production },
  { label: 'Read access',        icon: 'eye',              color: 'symbolIcon.variableForeground',   match: r => r.category === ReferenceCategory.ReadAccess && r.context === CodeContext.Production },
  { label: 'Write access',       icon: 'edit',             color: 'charts.orange',                   match: r => r.category === ReferenceCategory.WriteAccess && r.context === CodeContext.Production },
  { label: 'Tests · read',       icon: 'beaker',           color: 'testing.iconQueued',              match: r => r.context === CodeContext.Test && r.category === ReferenceCategory.ReadAccess },
  { label: 'Tests · write',      icon: 'beaker',           color: 'charts.orange',                   match: r => r.context === CodeContext.Test && r.category === ReferenceCategory.WriteAccess },
  { label: 'Tests · other',      icon: 'beaker',           color: 'testing.iconQueued',              match: r => r.context === CodeContext.Test &&
    r.category !== ReferenceCategory.ReadAccess && r.category !== ReferenceCategory.WriteAccess &&
    r.category !== ReferenceCategory.Definition && r.category !== ReferenceCategory.Implementation &&
    r.category !== ReferenceCategory.Proto && r.category !== ReferenceCategory.Comment,
  },
  { label: 'Comments',           icon: 'comment',          color: 'charts.yellow',                   match: r => r.category === ReferenceCategory.Comment },
];

function buildCategoryGroups(refs: ClassifiedReference[]): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  for (const def of CATEGORY_DEFS) {
    const matched = refs.filter(def.match);
    if (matched.length > 0) {
      groups.push({
        label: def.label,
        icon: new vscode.ThemeIcon(def.icon, new vscode.ThemeColor(def.color)),
        refs: matched,
        color: def.color,
      });
    }
  }
  return groups;
}

// ── Tree node classes ─────────────────────────────────────────────────────────

class CategoryGroupNode extends vscode.TreeItem {
  constructor(
    public readonly group: CategoryGroup,
  ) {
    const name = group.label;
    super({ label: name, highlights: [[0, name.length]] }, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${group.refs.length}`;
    this.iconPath = group.icon;
    this.resourceUri = makeCategoryUri(name);
    this.contextValue = 'categoryGroup';
  }
}

class DirectoryNode extends vscode.TreeItem {
  constructor(
    public readonly dirPath: string,
    public readonly refs: ClassifiedReference[],
    expand = true,
  ) {
    super(dirPath || '.', expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${refs.length}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'directoryNode';
  }
}

class FileNode extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly refs: ClassifiedReference[],
    expand = true,
  ) {
    super(path.basename(uri.fsPath), expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${refs.length}`;
    this.tooltip = uri.fsPath;
    this.resourceUri = uri;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = 'fileNode';
  }
}

class CallerNode extends vscode.TreeItem {
  constructor(
    public readonly callerName: string | undefined,
    public readonly refs: ClassifiedReference[],
    expand = true,
    comment?: string,
  ) {
    const label = callerName ?? '(module level)';
    super(label, expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.description = comment ? `${refs.length}  // ${comment}` : `${refs.length}`;
    this.iconPath = callerName
      ? new vscode.ThemeIcon('symbol-method')
      : new vscode.ThemeIcon('symbol-namespace');
    this.contextValue = 'callerNode';
  }
}

function buildReferenceLabel(ref: ClassifiedReference): string {
  return ref.lineText.trimStart();
}

function buildContextTooltip(ref: ClassifiedReference): vscode.MarkdownString {
  const line = ref.location.range.start.line + 1;
  const fsPath = ref.location.uri.fsPath;
  const before = ref.contextLines?.before ?? [];
  const after  = ref.contextLines?.after  ?? [];
  const startLine = line - before.length;

  const annotated = [
    ...before.map((t, i) => `${String(startLine + i).padStart(5)}   ${t}`),
    `${String(line).padStart(5)} → ${ref.lineText}`,
    ...after.map((t, i)  => `${String(line + 1 + i).padStart(5)}   ${t}`),
  ].join('\n');

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${fsPath}:${line}**\n\n`);
  md.appendCodeblock(annotated, 'plaintext');
  return md;
}

export class ReferenceItem extends vscode.TreeItem {
  constructor(public readonly ref: ClassifiedReference) {
    const line = ref.location.range.start.line + 1;
    super(buildReferenceLabel(ref), vscode.TreeItemCollapsibleState.None);

    this.description = `:${line}`;
    this.tooltip = buildContextTooltip(ref);
    this.command = {
      command: 'smartReferences.previewReference',
      title: 'Preview Reference',
      arguments: [ref.location.uri, ref.location.range],
    };
    this.contextValue = 'referenceItem';
    this.resourceUri = ref.location.uri;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

const MAX_HISTORY = 20;
// When total references exceed this threshold, only the category level is
// auto-expanded; directory / file / caller nodes start collapsed.
const AUTO_EXPAND_THRESHOLD = 20;

interface HistoryEntry {
  symbolName: string;
  refs: ClassifiedReference[];
}

export class ReferenceTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private symbolName = '';
  private allRefs: ClassifiedReference[] = [];
  private refs: ClassifiedReference[] = [];
  private expandSubLevels = true;
  private workspaceRoot?: string;
  private scopeFilter: ReferenceScopeFilter = 'all';

  private history: HistoryEntry[] = [];
  private historyIndex = -1;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  setResults(symbolName: string, refs: ClassifiedReference[]): void {
    this.symbolName = symbolName;
    this.allRefs = refs;
    this.applyFilter();
    // Truncate forward history, push new entry
    this.history.splice(this.historyIndex + 1);
    this.history.push({ symbolName, refs });
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
    this.allRefs = entry.refs;
    this.applyFilter();
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.symbolName = '';
    this.allRefs = [];
    this.refs = [];
    this._onDidChangeTreeData.fire();
  }

  setScopeFilter(filter: ReferenceScopeFilter): void {
    if (this.scopeFilter === filter) return;
    this.scopeFilter = filter;
    this.applyFilter();
    this._onDidChangeTreeData.fire();
  }

  getScopeFilter(): ReferenceScopeFilter {
    return this.scopeFilter;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getChildren(element?: TreeNode): TreeNode[] | Thenable<TreeNode[]> {
    if (!element) {
      return buildCategoryGroups(this.refs).map(g => new CategoryGroupNode(g));
    }
    if (element instanceof CategoryGroupNode) {
      return this.buildDirectoryNodes(element.group.refs);
    }
    if (element instanceof DirectoryNode) {
      return this.buildFileNodes(element.refs);
    }
    if (element instanceof FileNode) {
      return this.buildCallerNodes(element.refs, element.uri);
    }
    if (element instanceof CallerNode) {
      return element.refs
        .sort((a, b) => a.location.range.start.line - b.location.range.start.line)
        .map(r => new ReferenceItem(r));
    }
    return [];
  }

  private getRelativeDir(fsPath: string): string {
    if (!this.workspaceRoot) return path.dirname(fsPath);
    return path.relative(this.workspaceRoot, path.dirname(fsPath)) || '.';
  }

  private buildDirectoryNodes(refs: ClassifiedReference[]): TreeNode[] {
    const byDir = new Map<string, ClassifiedReference[]>();
    for (const ref of refs) {
      const dir = this.getRelativeDir(ref.location.uri.fsPath);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(ref);
    }

    return Array.from(byDir.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, dirRefs]) => new DirectoryNode(dir, dirRefs, this.expandSubLevels));
  }

  private buildFileNodes(refs: ClassifiedReference[]): FileNode[] {
    const byFile = new Map<string, ClassifiedReference[]>();
    for (const ref of refs) {
      const key = ref.location.uri.toString();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(ref);
    }
    return Array.from(byFile.values())
      .sort((a, b) => a[0].location.uri.fsPath.localeCompare(b[0].location.uri.fsPath))
      .map(r => new FileNode(r[0].location.uri, r, this.expandSubLevels));
  }

  private async buildCallerNodes(refs: ClassifiedReference[], fileUri: vscode.Uri): Promise<TreeNode[]> {
    const bySymbol = new Map<string, ClassifiedReference[]>();
    for (const ref of refs) {
      const key = ref.containingSymbol ?? '';
      if (!bySymbol.has(key)) bySymbol.set(key, []);
      bySymbol.get(key)!.push(ref);
    }

    // Single group with no named caller — skip caller level
    if (bySymbol.size === 1 && !refs[0].containingSymbol) {
      return refs
        .sort((a, b) => a.location.range.start.line - b.location.range.start.line)
        .map(r => new ReferenceItem(r));
    }

    // Load document + symbols to extract doc comments for callers
    const commentMap = new Map<string, string>();
    try {
      const [doc, symbols] = await Promise.all([
        vscode.workspace.openTextDocument(fileUri),
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', fileUri),
      ]);
      if (doc && Array.isArray(symbols)) {
        const flat = flattenSymbols(symbols);
        for (const sym of flat) {
          const comment = extractDocComment(doc, sym.range.start.line);
          if (comment) commentMap.set(sym.name, comment);
        }
      }
    } catch { /* doc comment loading is best-effort */ }

    return Array.from(bySymbol.entries())
      .sort(([, a], [, b]) => a[0].location.range.start.line - b[0].location.range.start.line)
      .map(([sym, symRefs]) =>
        new CallerNode(
          sym || undefined,
          symRefs.sort((a, b) => a.location.range.start.line - b.location.range.start.line),
          this.expandSubLevels,
          sym ? commentMap.get(sym) : undefined,
        )
      );
  }

  getSymbolLabel(): string {
    if (!this.symbolName) return '';
    const suffix = this.scopeFilter === 'all'
      ? 'All'
      : this.scopeFilter === 'production' ? 'Production' : 'Tests';
    return `${this.symbolName} (${this.refs.length} usages · ${suffix})`;
  }

  private applyFilter(): void {
    this.refs = this.allRefs.filter(ref => {
      if (this.scopeFilter === 'all') return true;
      if (this.scopeFilter === 'production') return ref.context === CodeContext.Production;
      return ref.context === CodeContext.Test;
    });
    this.expandSubLevels = this.refs.length <= AUTO_EXPAND_THRESHOLD;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

function flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];
  for (const sym of symbols) {
    result.push(sym);
    if (sym.children.length > 0) result.push(...flattenSymbols(sym.children));
  }
  return result;
}
