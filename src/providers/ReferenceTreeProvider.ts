import * as vscode from 'vscode';
import * as path from 'path';
import { ClassifiedReference, ReferenceCategory, CodeContext, locationKey } from '../core/ReferenceTypes';

// Serialized form of a pin for workspaceState persistence
export interface SerializedPinRef {
  uri: string;
  sl: number; sc: number; el: number; ec: number;
  cat: number; ctx: number;
  line: string;
  sym?: string;
}
export interface SerializedPin {
  id: string;
  symbolName: string;
  refs: SerializedPinRef[];
  scopeFilter: ReferenceScopeFilter;
  groupingMode: ReferenceGroupingMode;
  pinnedAt: number;
  anchorUri?: string;
  note?: string;
}
import { makeCategoryUri } from './CategoryDecorationProvider';
import { extractDocComment } from './StructureTreeProvider';

type TreeNode = SummaryNode | CategoryGroupNode | DirectoryNode | FileNode | CallerNode | ReferenceItem;
export type ReferenceScopeFilter =
  | 'all'
  | 'production'
  | 'test'
  | 'currentFile'
  | 'currentDirectory'
  | 'workspaceSource';
export type ReferenceGroupingMode = 'directory' | 'file';

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

// ── Summary node ─────────────────────────────────────────────────────────────

class SummaryNode extends vscode.TreeItem {
  constructor(refs: ClassifiedReference[], keywordFilter: string) {
    const fileCount = new Set(refs.map(r => r.location.uri.toString())).size;
    const dirCount = new Set(refs.map(r => path.dirname(r.location.uri.fsPath))).size;
    const testCount = refs.filter(r => r.context === CodeContext.Test).length;
    const parts = [`${refs.length} refs`, `${fileCount} ${fileCount !== 1 ? 'files' : 'file'}`];
    if (dirCount > 1) parts.push(`${dirCount} dirs`);
    if (testCount > 0) parts.push(`${testCount} in tests`);
    super(parts.join(' · '), vscode.TreeItemCollapsibleState.None);
    if (keywordFilter) this.description = `filter: "${keywordFilter}"`;
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'summaryNode';
  }
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
    labelText?: string,
  ) {
    super(labelText ?? path.basename(uri.fsPath), expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
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
const MAX_PINNED = 20;
// When total references exceed this threshold, only the category level is
// auto-expanded; directory / file / caller nodes start collapsed.
const AUTO_EXPAND_THRESHOLD = 20;

interface HistoryEntry {
  symbolName: string;
  refs: ClassifiedReference[];
  anchorUri?: vscode.Uri;
}

export interface PinnedReferenceResult {
  id: string;
  symbolName: string;
  refs: ClassifiedReference[];
  scopeFilter: ReferenceScopeFilter;
  groupingMode: ReferenceGroupingMode;
  pinnedAt: number;
  anchorUri?: vscode.Uri;
  note?: string;
}

export class ReferenceTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private symbolName = '';
  private allRefs: ClassifiedReference[] = [];
  private refs: ClassifiedReference[] = [];
  private expandSubLevels = true;
  private workspaceRoot?: string;
  private scopeAnchorUri?: vscode.Uri;
  private scopeFilter: ReferenceScopeFilter = 'all';
  private groupingMode: ReferenceGroupingMode = 'directory';

  private history: HistoryEntry[] = [];
  private historyIndex = -1;
  private pinnedResults: PinnedReferenceResult[] = [];
  private keywordFilter: string = '';
  private fileHitCountsCache: Map<string, number> | undefined;
  private readonly _onPinnedResultsChanged = new vscode.EventEmitter<void>();
  readonly onPinnedResultsChanged: vscode.Event<void> = this._onPinnedResultsChanged.event;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  setResults(symbolName: string, refs: ClassifiedReference[], anchorUri?: vscode.Uri): void {
    this.symbolName = symbolName;
    this.allRefs = refs;
    this.scopeAnchorUri = anchorUri?.scheme === 'file' ? anchorUri : this.scopeAnchorUri;
    this.applyFilter();
    // Truncate forward history, push new entry
    this.history.splice(this.historyIndex + 1);
    this.history.push({ symbolName, refs, anchorUri: this.scopeAnchorUri });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.historyIndex = this.history.length - 1;
    this.fileHitCountsCache = undefined;
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
    this.scopeAnchorUri = entry.anchorUri;
    this.applyFilter();
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.symbolName = '';
    this.allRefs = [];
    this.refs = [];
    this._onDidChangeTreeData.fire();
  }

  hasResults(): boolean {
    return this.allRefs.length > 0;
  }

  setScopeAnchor(uri: vscode.Uri | undefined): void {
    this.scopeAnchorUri = uri?.scheme === 'file' ? uri : undefined;
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

  setKeywordFilter(keyword: string): void {
    const normalized = keyword.toLowerCase().trim();
    if (this.keywordFilter === normalized) return;
    this.keywordFilter = normalized;
    this.applyFilter();
    this._onDidChangeTreeData.fire();
  }

  getKeywordFilter(): string {
    return this.keywordFilter;
  }

  setGroupingMode(mode: ReferenceGroupingMode): void {
    if (this.groupingMode === mode) return;
    this.groupingMode = mode;
    this._onDidChangeTreeData.fire();
  }

  getGroupingMode(): ReferenceGroupingMode {
    return this.groupingMode;
  }

  pinCurrentResults(): { entry: PinnedReferenceResult; isNew: boolean } | undefined {
    if (!this.hasResults()) return undefined;

    const existing = this.pinnedResults.find(entry => this.isSameSnapshot(entry.symbolName, entry.refs, this.allRefs));
    if (existing) {
      existing.scopeFilter = this.scopeFilter;
      existing.groupingMode = this.groupingMode;
      existing.pinnedAt = Date.now();
      existing.anchorUri = this.scopeAnchorUri;
      this.sortPinnedResults();
      return { entry: existing, isNew: false };
    }

    const entry: PinnedReferenceResult = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbolName: this.symbolName,
      refs: [...this.allRefs],
      scopeFilter: this.scopeFilter,
      groupingMode: this.groupingMode,
      pinnedAt: Date.now(),
      anchorUri: this.scopeAnchorUri,
    };
    this.pinnedResults.unshift(entry);
    if (this.pinnedResults.length > MAX_PINNED) {
      this.pinnedResults.length = MAX_PINNED;
    }
    this._onPinnedResultsChanged.fire();
    return { entry, isNew: true };
  }

  getPinnedResults(): readonly PinnedReferenceResult[] {
    return this.pinnedResults;
  }

  openPinnedResult(id: string): boolean {
    const entry = this.pinnedResults.find(item => item.id === id);
    if (!entry) return false;

    this.scopeFilter = entry.scopeFilter;
    this.groupingMode = entry.groupingMode;
    this.setResults(entry.symbolName, entry.refs, entry.anchorUri);
    return true;
  }

  removePinnedResult(id: string): boolean {
    const before = this.pinnedResults.length;
    this.pinnedResults = this.pinnedResults.filter(entry => entry.id !== id);
    const changed = this.pinnedResults.length !== before;
    if (changed) this._onPinnedResultsChanged.fire();
    return changed;
  }

  setPinnedNote(id: string, note: string): void {
    const pin = this.pinnedResults.find(p => p.id === id);
    if (!pin) return;
    pin.note = note.trim() || undefined;
    this._onPinnedResultsChanged.fire();
  }

  loadPins(pins: PinnedReferenceResult[]): void {
    this.pinnedResults = pins;
    this.sortPinnedResults();
  }

  serializePins(): SerializedPin[] {
    return this.pinnedResults.map(pin => ({
      id: pin.id,
      symbolName: pin.symbolName,
      refs: pin.refs.map(r => ({
        uri: r.location.uri.toString(),
        sl: r.location.range.start.line,
        sc: r.location.range.start.character,
        el: r.location.range.end.line,
        ec: r.location.range.end.character,
        cat: r.category as unknown as number,
        ctx: r.context as unknown as number,
        line: r.lineText,
        sym: r.containingSymbol,
      })),
      scopeFilter: pin.scopeFilter,
      groupingMode: pin.groupingMode,
      pinnedAt: pin.pinnedAt,
      anchorUri: pin.anchorUri?.toString(),
      note: pin.note,
    }));
  }

  static deserializePins(data: SerializedPin[]): PinnedReferenceResult[] {
    return data.map(pin => ({
      id: pin.id,
      symbolName: pin.symbolName,
      refs: pin.refs.map(r => ({
        location: new vscode.Location(
          vscode.Uri.parse(r.uri),
          new vscode.Range(r.sl, r.sc, r.el, r.ec),
        ),
        category: r.cat as unknown as ReferenceCategory,
        context: r.ctx as unknown as CodeContext,
        lineText: r.line,
        containingSymbol: r.sym,
      })),
      scopeFilter: pin.scopeFilter as ReferenceScopeFilter,
      groupingMode: pin.groupingMode as ReferenceGroupingMode,
      pinnedAt: pin.pinnedAt,
      anchorUri: pin.anchorUri ? vscode.Uri.parse(pin.anchorUri) : undefined,
      note: pin.note,
    }));
  }

  getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

  getParent(element: TreeNode): TreeNode | undefined {
    if (element instanceof SummaryNode) return undefined;
    if (element instanceof CategoryGroupNode) return undefined;

    if (element instanceof DirectoryNode) {
      const category = this.buildCategoryGroupForRef(element.refs[0]);
      return category ? new CategoryGroupNode(category) : undefined;
    }

    if (element instanceof FileNode) {
      const category = this.buildCategoryGroupForRef(element.refs[0]);
      if (!category) return undefined;
      if (this.groupingMode === 'file') return new CategoryGroupNode(category);
      const dirRefs = category.refs.filter(ref => this.getRelativeDir(ref.location.uri.fsPath) === this.getRelativeDir(element.uri.fsPath));
      return new DirectoryNode(this.getRelativeDir(element.uri.fsPath), dirRefs, this.expandSubLevels);
    }

    if (element instanceof CallerNode) {
      const fileRefs = this.refs.filter(ref => ref.location.uri.toString() === element.refs[0].location.uri.toString());
      return this.createFileNodeForRefs(fileRefs);
    }

    return this.getParentForReference(element.ref);
  }

  getRevealTarget(uri: vscode.Uri, position?: vscode.Position): TreeNode | undefined {
    const fileRefs = this.refs.filter(ref => ref.location.uri.toString() === uri.toString());
    if (fileRefs.length === 0) return undefined;

    const match = this.pickRevealReference(fileRefs, position);
    if (match) return new ReferenceItem(match);
    return this.createFileNodeForRefs(fileRefs);
  }

  getChildren(element?: TreeNode): TreeNode[] | Thenable<TreeNode[]> {
    if (!element) {
      const groups = buildCategoryGroups(this.refs).map(g => new CategoryGroupNode(g));
      if (this.refs.length > 0) {
        return [new SummaryNode(this.refs, this.keywordFilter), ...groups];
      }
      return groups;
    }
    if (element instanceof CategoryGroupNode) {
      return this.groupingMode === 'directory'
        ? this.buildDirectoryNodes(element.group.refs)
        : this.buildFileNodes(element.group.refs, true);
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

  private getRelativeFilePath(fsPath: string): string {
    if (!this.workspaceRoot) return fsPath;
    return path.relative(this.workspaceRoot, fsPath) || path.basename(fsPath);
  }

  private getParentForReference(ref: ClassifiedReference): TreeNode | undefined {
    const fileRefs = this.refs.filter(candidate => candidate.location.uri.toString() === ref.location.uri.toString());
    if (fileRefs.length === 0) return undefined;
    if (this.shouldSkipCallerLevel(fileRefs)) {
      return this.createFileNodeForRefs(fileRefs);
    }
    const callerRefs = fileRefs
      .filter(candidate => (candidate.containingSymbol ?? '') === (ref.containingSymbol ?? ''))
      .sort((a, b) => a.location.range.start.line - b.location.range.start.line);
    return new CallerNode(
      ref.containingSymbol,
      callerRefs,
      this.expandSubLevels,
    );
  }

  private createFileNodeForRefs(fileRefs: ClassifiedReference[]): FileNode {
    return new FileNode(
      fileRefs[0].location.uri,
      fileRefs,
      this.expandSubLevels,
      this.groupingMode === 'file' ? this.getRelativeFilePath(fileRefs[0].location.uri.fsPath) : undefined,
    );
  }

  private shouldSkipCallerLevel(refs: ClassifiedReference[]): boolean {
    const symbols = new Set(refs.map(ref => ref.containingSymbol ?? ''));
    return symbols.size === 1 && !refs[0].containingSymbol;
  }

  private buildCategoryGroupForRef(ref: ClassifiedReference): CategoryGroup | undefined {
    for (const def of CATEGORY_DEFS) {
      if (def.match(ref)) {
        const refs = this.refs.filter(candidate => def.match(candidate));
        return {
          label: def.label,
          icon: new vscode.ThemeIcon(def.icon, new vscode.ThemeColor(def.color)),
          refs,
          color: def.color,
        };
      }
    }
    return undefined;
  }

  private pickRevealReference(refs: ClassifiedReference[], position?: vscode.Position): ClassifiedReference | undefined {
    if (!position) return refs[0];

    const containing = refs.find(ref => ref.location.range.contains(position));
    if (containing) return containing;

    const sameLine = refs.find(ref => ref.location.range.start.line === position.line);
    if (sameLine) return sameLine;

    return refs[0];
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

  private buildFileNodes(refs: ClassifiedReference[], showRelativePath = false): FileNode[] {
    const byFile = new Map<string, ClassifiedReference[]>();
    for (const ref of refs) {
      const key = ref.location.uri.toString();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(ref);
    }
    return Array.from(byFile.values())
      .sort((a, b) => a[0].location.uri.fsPath.localeCompare(b[0].location.uri.fsPath))
      .map(r => new FileNode(
        r[0].location.uri,
        r,
        this.expandSubLevels,
        showRelativePath ? this.getRelativeFilePath(r[0].location.uri.fsPath) : undefined,
      ));
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

  getFileHitCounts(): Map<string, number> {
    if (this.fileHitCountsCache) return this.fileHitCountsCache;
    const counts = new Map<string, number>();
    for (const entry of this.history) {
      for (const ref of entry.refs) {
        const fsPath = ref.location.uri.fsPath;
        counts.set(fsPath, (counts.get(fsPath) ?? 0) + 1);
      }
    }
    this.fileHitCountsCache = counts;
    return counts;
  }

  formatAsMarkdown(): string {
    if (!this.symbolName || this.refs.length === 0) return '';
    const lines: string[] = [`# References: \`${this.symbolName}\`\n`];
    const groups = buildCategoryGroups(this.refs);
    for (const g of groups) {
      lines.push(`## ${g.label}`);
      const byFile = new Map<string, ClassifiedReference[]>();
      for (const ref of g.refs) {
        const key = ref.location.uri.fsPath;
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key)!.push(ref);
      }
      for (const [file, fileRefs] of byFile) {
        const relPath = vscode.workspace.asRelativePath(file);
        lines.push(`\n### ${relPath}`);
        for (const ref of fileRefs) {
          const line = ref.location.range.start.line + 1;
          const symbol = ref.containingSymbol ? ` (in \`${ref.containingSymbol}\`)` : '';
          lines.push(`- L${line}${symbol}: \`${ref.lineText.trim()}\``);
        }
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  getSymbolLabel(): string {
    if (!this.symbolName) return '';
    const suffix = this.scopeFilterLabel();
    return `${this.symbolName} (${this.refs.length} usages · ${suffix})`;
  }

  private applyFilter(): void {
    const keyword = this.keywordFilter;
    this.refs = this.allRefs.filter(ref => {
      switch (this.scopeFilter) {
        case 'production':
          if (ref.context !== CodeContext.Production) return false;
          break;
        case 'test':
          if (ref.context !== CodeContext.Test) return false;
          break;
        case 'currentFile':
          if (!this.scopeAnchorUri || ref.location.uri.toString() !== this.scopeAnchorUri.toString()) return false;
          break;
        case 'currentDirectory':
          if (!this.scopeAnchorUri || path.dirname(ref.location.uri.fsPath) !== path.dirname(this.scopeAnchorUri.fsPath)) return false;
          break;
        case 'workspaceSource':
          if (!this.isWorkspaceSourceUri(ref.location.uri)) return false;
          break;
      }
      if (keyword && !ref.lineText.toLowerCase().includes(keyword) && !ref.containingSymbol?.toLowerCase().includes(keyword)) {
        return false;
      }
      return true;
    });
    this.expandSubLevels = this.refs.length <= AUTO_EXPAND_THRESHOLD;
  }

  private scopeFilterLabel(): string {
    switch (this.scopeFilter) {
      case 'all': return 'All';
      case 'production': return 'Production';
      case 'test': return 'Tests';
      case 'currentFile': return 'Current File';
      case 'currentDirectory': return 'Current Directory';
      case 'workspaceSource': return 'Workspace Source';
    }
  }

  private isWorkspaceSourceUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !this.workspaceRoot) return false;
    const relative = path.relative(this.workspaceRoot, uri.fsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const normalized = relative.split(path.sep).join('/');
    if (normalized.endsWith('.d.ts')) return false;
    if (/(^|\/)(node_modules|vendor|dist|out|build|coverage|target|\.git)(\/|$)/.test(normalized)) return false;
    return true;
  }

  private isSameSnapshot(symbolName: string, refsA: ClassifiedReference[], refsB: ClassifiedReference[]): boolean {
    if (this.symbolName !== symbolName) return false;
    if (refsA.length !== refsB.length) return false;

    const aKeys = refsA.map(ref => locationKey(ref.location)).sort();
    const bKeys = refsB.map(ref => locationKey(ref.location)).sort();
    return aKeys.every((key, index) => key === bKeys[index]);
  }

  private sortPinnedResults(): void {
    this.pinnedResults.sort((a, b) => b.pinnedAt - a.pinnedAt);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
    this._onPinnedResultsChanged.dispose();
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
