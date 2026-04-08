import * as vscode from 'vscode';
import * as path from 'path';
import { ReferencePreviewManager } from './ReferencePreviewManager';
import {
  SymbolRanker,
  RankedSymbol,
  RankedFile,
  SymbolCategory,
  CATEGORY_ORDER,
  symbolKindToCategory,
  symbolKindToIconId,
} from '../core/SymbolRanker';
import { MAX_FILE_SEARCH_RESULTS } from '../core/constants';
import { TestFileDetector } from '../analyzers/TestFileDetector';
import { DepSymbolIndexer } from '../core/GoDepSymbolIndexer';
import { detectMainWorkspaceLanguage, WorkspaceLanguageId } from '../core/WorkspaceLanguage';
import { ProtoWorkspaceNavigator } from '../core/ProtoWorkspaceNavigator';

// ── QuickPick item ───────────────────────────────────────────────────────────

interface SymbolQuickPickItem extends vscode.QuickPickItem {
  symbolInfo?: vscode.SymbolInformation;
  fileUri?: vscode.Uri;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class SymbolSearchProvider implements vscode.Disposable {
  private quickPick: vscode.QuickPick<SymbolQuickPickItem> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private currentCts: vscode.CancellationTokenSource | undefined;
  private readonly ranker = new SymbolRanker();
  private readonly previewer: ReferencePreviewManager;
  private readonly testDetector: TestFileDetector;
  private readonly log: vscode.OutputChannel;
  private readonly protoNavigator: ProtoWorkspaceNavigator;
  private depIndexer: DepSymbolIndexer | undefined;
  private contextUri: vscode.Uri | undefined;
  private activeCategories: SymbolCategory[] = [];
  private mainLangExts: string[] = [];
  private mainLangId: WorkspaceLanguageId = 'unknown';
  private config = { debounceMs: 150, maxPerCategory: 15, maxTotal: 80 };
  private isDepSearch = false;
  private depSymbolCache: vscode.SymbolInformation[] | undefined;

  constructor(
    previewer: ReferencePreviewManager,
    testDetector: TestFileDetector,
    log: vscode.OutputChannel,
    protoNavigator: ProtoWorkspaceNavigator,
  ) {
    this.previewer = previewer;
    this.testDetector = testDetector;
    this.log = log;
    this.protoNavigator = protoNavigator;
  }

  setDepIndexer(indexer: DepSymbolIndexer): void {
    this.depIndexer = indexer;
  }

  async show(categories: SymbolCategory[]): Promise<void> {
    if (this.quickPick) {
      this.quickPick.dispose();
    }

    const cfg = vscode.workspace.getConfiguration('smartReferences');
    this.config = {
      debounceMs: cfg.get<number>('symbolSearch.debounceMs', 150),
      maxPerCategory: cfg.get<number>('symbolSearch.maxResultsPerCategory', 15),
      maxTotal: 80,
    };

    this.activeCategories = categories;
    const langProfile = await detectMainWorkspaceLanguage();
    this.mainLangExts = langProfile.extensions;
    this.mainLangId = langProfile.id;
    this.log.appendLine(`[init] main language: ${this.mainLangId}, extensions: [${this.mainLangExts.join(', ')}]`);
    const editor = vscode.window.activeTextEditor;
    this.contextUri = editor?.document.uri;

    const qp = vscode.window.createQuickPick<SymbolQuickPickItem>();
    this.quickPick = qp;

    qp.title = buildTitle(categories);
    qp.placeholder = buildPlaceholder(categories);
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;

    qp.onDidChangeValue(value => this.onQueryChanged(value), undefined);
    qp.onDidAccept(() => this.onAccepted(), undefined);
    qp.onDidHide(() => this.cleanup(), undefined);

    // Pre-fill with selected text if available
    if (editor && !editor.selection.isEmpty) {
      const selectedText = editor.document.getText(editor.selection);
      if (selectedText.length <= 60 && !selectedText.includes('\n')) {
        qp.value = selectedText;
        this.onQueryChanged(selectedText);
      }
    }

    if (!qp.value) {
      void this.showEmptyState();
    }

    qp.show();
  }

  async showDepSymbolSearch(): Promise<void> {
    if (!this.depIndexer) {
      vscode.window.showWarningMessage('Dependency indexer not available.');
      return;
    }

    if (this.quickPick) {
      this.quickPick.dispose();
    }

    const cfg = vscode.workspace.getConfiguration('smartReferences');
    this.config = {
      debounceMs: cfg.get<number>('symbolSearch.debounceMs', 150),
      maxPerCategory: cfg.get<number>('symbolSearch.maxResultsPerCategory', 15),
      maxTotal: 80,
    };

    this.isDepSearch = true;
    this.depSymbolCache = undefined;
    this.activeCategories = [SymbolCategory.Function, SymbolCategory.Class, SymbolCategory.Interface];
    const depLangProfile = await detectMainWorkspaceLanguage();
    this.mainLangExts = depLangProfile.extensions;
    this.mainLangId = depLangProfile.id;
    this.contextUri = vscode.window.activeTextEditor?.document.uri;

    const qp = vscode.window.createQuickPick<SymbolQuickPickItem>();
    this.quickPick = qp;

    qp.title = 'Search Dependency Symbols';
    qp.placeholder = 'Type to search functions, types, and interfaces in dependencies';
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    qp.busy = true;

    qp.onDidChangeValue(value => this.onQueryChanged(value), undefined);
    qp.onDidAccept(() => this.onAccepted(), undefined);
    qp.onDidHide(() => {
      this.isDepSearch = false;
      this.cleanup();
    }, undefined);

    qp.show();

    // Build index in background; once done, trigger a search if there's already a query
    this.depIndexer.getSymbols().then(symbols => {
      this.depSymbolCache = symbols;
      this.log.appendLine(`[dep-search] index ready: ${symbols.length} symbols`);
      if (this.quickPick) {
        this.quickPick.busy = false;
        if (this.quickPick.value) {
          this.onQueryChanged(this.quickPick.value);
        }
      }
    }).catch(err => {
      this.log.appendLine(`[dep-search] index error: ${String(err)}`);
      if (this.quickPick) this.quickPick.busy = false;
    });
  }

  private onQueryChanged(rawInput: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.currentCts) {
      this.currentCts.cancel();
      this.currentCts.dispose();
      this.currentCts = undefined;
    }

    const query = rawInput.trim();

    if (!query) {
      if (!this.isDepSearch) {
        void this.showEmptyState();
      } else if (this.quickPick) {
        this.quickPick.items = [];
      }
      return;
    }

    // Skip single-character queries — too broad, slow LSP response
    if (query.length < 2) {
      if (this.quickPick) {
        this.quickPick.items = [];
        this.quickPick.busy = false;
      }
      return;
    }

    if (this.quickPick) this.quickPick.busy = true;

    this.debounceTimer = setTimeout(() => {
      if (this.isDepSearch) {
        this.performDepSearch(query);
      } else {
        this.currentCts = new vscode.CancellationTokenSource();
        this.performSearch(query, this.currentCts.token);
      }
    }, this.config.debounceMs);
  }

  private async performSearch(
    query: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    try {
      const symbolPromise = (async () => {
        let symbols: vscode.SymbolInformation[] | undefined;
        let queryAliases: string[] = [];
        if (this.contextUri && this.protoNavigator.isProtoUri(this.contextUri)) {
          const protoSearch = await this.protoNavigator.searchSymbolsForQuery(this.contextUri, query);
          symbols = protoSearch.symbols;
          queryAliases = protoSearch.aliases;
        }
        if (!symbols || symbols.length === 0) {
          symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            query,
          );
        }
        return { symbols: symbols ?? [], queryAliases };
      })();

      const shouldSearchFiles = this.activeCategories.length === 0;
      const filePromise = shouldSearchFiles
        ? vscode.workspace.findFiles(
            `**/*${toInsensitiveGlob(query)}*`,
            getFileSearchExcludePattern(this.mainLangId),
            MAX_FILE_SEARCH_RESULTS,
            token,
          )
        : Promise.resolve([]);

      const [{ symbols: all, queryAliases }, fileUris] = await Promise.all([symbolPromise, filePromise]);
      if (token.isCancellationRequested || !this.quickPick) return;

      const filteredSymbols = all.filter(s => matchesActiveCategories(s.kind, this.activeCategories));
      this.log.appendLine(`[search] query="${query}" aliases=[${queryAliases.join(',')}] categories=[${this.activeCategories.join(',')}] raw=${all.length} symbols, files=${fileUris.length}`);
      const kindCounts: Record<number, number> = {};
      const extCounts: Record<string, number> = {};
      for (const s of all) {
        kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
        const ext = s.location.uri.fsPath.split('.').pop() ?? '?';
        extCounts[ext] = (extCounts[ext] ?? 0) + 1;
      }
      this.log.appendLine(`[search] kind distribution: ${JSON.stringify(kindCounts)}`);
      this.log.appendLine(`[search] file ext distribution: ${JSON.stringify(extCounts)}`);
      for (const s of all.slice(0, 10)) {
        const rel = vscode.workspace.asRelativePath(s.location.uri);
        this.log.appendLine(`[search]   kind=${s.kind} name="${s.name}" file=${rel}`);
      }

      const ranked = this.ranker.rank(
        query,
        filteredSymbols,
        this.contextUri,
        this.config.maxTotal,
        this.activeCategories,
        this.mainLangExts,
        uri => this.testDetector.isTestFile(uri),
        queryAliases,
      );
      this.log.appendLine(`[search] after rank+dedup: ${ranked.length}`);

      const rankedFiles = shouldSearchFiles
        ? this.ranker.rankFiles(
            query,
            fileUris,
            this.contextUri,
            this.config.maxPerCategory,
            this.mainLangExts,
            uri => this.testDetector.isTestFile(uri),
          )
        : [];

      this.quickPick.items = this.buildItems(ranked, rankedFiles);
    } catch (err) {
      this.log.appendLine(`[search] error: ${String(err)}`);
    } finally {
      if (this.quickPick) this.quickPick.busy = false;
    }
  }

  private performDepSearch(query: string): void {
    if (!this.quickPick) return;

    // If index not ready yet, stay busy (will trigger again when cache is filled)
    if (!this.depSymbolCache) {
      this.log.appendLine(`[dep-search] query="${query}" but index not ready yet`);
      return;
    }

    try {
      const all = this.depSymbolCache;
      const lq = query.toLowerCase();
      const filtered = all.filter(s => s.name.toLowerCase().includes(lq));
      this.log.appendLine(`[dep-search] query="${query}" pre-filter=${filtered.length}/${all.length}`);

      const ranked = this.ranker.rank(
        query,
        filtered,
        this.contextUri,
        this.config.maxTotal,
        this.activeCategories,
        this.mainLangExts,
        () => false,
      );
      this.log.appendLine(`[dep-search] after rank: ${ranked.length}`);
      this.quickPick.items = this.buildItems(ranked);
    } catch (err) {
      this.log.appendLine(`[dep-search] error: ${String(err)}`);
    } finally {
      if (this.quickPick) this.quickPick.busy = false;
    }
  }

  private buildItems(ranked: RankedSymbol[], files: RankedFile[] = []): SymbolQuickPickItem[] {
    const cats = this.activeCategories;
    const prodGrouped = new Map<SymbolCategory, RankedSymbol[]>();
    const testGrouped = new Map<SymbolCategory, RankedSymbol[]>();
    for (const r of ranked) {
      const map = this.testDetector.isTestFile(r.symbol.location.uri) ? testGrouped : prodGrouped;
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category)!.push(r);
    }

    const items: SymbolQuickPickItem[] = [];
    const catOrder = cats.length > 0 ? cats : CATEGORY_ORDER;
    const symbolCatOrder = catOrder.filter(c => c !== SymbolCategory.File);
    const perCat = cats.length > 0 ? this.config.maxTotal : this.config.maxPerCategory;

    const pushSymbol = (s: RankedSymbol) => {
      const rel = vscode.workspace.asRelativePath(s.symbol.location.uri);
      const line = s.symbol.location.range.start.line + 1;
      const iconId = symbolKindToIconId(s.symbol.kind);
      const container = this.isDepSearch
        ? (s.symbol.containerName ?? '')
        : (s.symbol.containerName ? s.symbol.containerName.split('/').pop() ?? '' : '');
      items.push({
        label: `$(${iconId}) ${s.symbol.name}`,
        description: container,
        detail: `${rel}:${line}`,
        symbolInfo: s.symbol,
        alwaysShow: true,
      });
    };

    const pushFile = (f: RankedFile) => {
      const rel = vscode.workspace.asRelativePath(f.uri);
      const basename = path.basename(f.uri.fsPath);
      items.push({
        label: `$(file) ${basename}`,
        detail: rel,
        fileUri: f.uri,
        alwaysShow: true,
      });
    };

    // Production symbols
    for (const cat of symbolCatOrder) {
      const symbols = prodGrouped.get(cat);
      if (!symbols || symbols.length === 0) continue;
      items.push({ label: cat, kind: vscode.QuickPickItemKind.Separator });
      for (const s of symbols.slice(0, perCat)) pushSymbol(s);
    }

    // Split files into production and test
    const prodFiles: RankedFile[] = [];
    const testFiles: RankedFile[] = [];
    for (const f of files) {
      (this.testDetector.isTestFile(f.uri) ? testFiles : prodFiles).push(f);
    }

    if (prodFiles.length > 0) {
      items.push({ label: SymbolCategory.File, kind: vscode.QuickPickItemKind.Separator });
      for (const f of prodFiles.slice(0, perCat)) pushFile(f);
    }

    // Test symbols
    for (const cat of symbolCatOrder) {
      const symbols = testGrouped.get(cat);
      if (!symbols || symbols.length === 0) continue;
      items.push({ label: `${cat}  $(beaker) Tests`, kind: vscode.QuickPickItemKind.Separator });
      for (const s of symbols.slice(0, perCat)) pushSymbol(s);
    }

    if (testFiles.length > 0) {
      items.push({ label: `${SymbolCategory.File}  $(beaker) Tests`, kind: vscode.QuickPickItemKind.Separator });
      for (const f of testFiles.slice(0, perCat)) pushFile(f);
    }

    return items;
  }

  // ── Empty state: current file symbols + recent ─────────────────────────────

  private async showEmptyState(): Promise<void> {
    if (!this.quickPick) return;
    const cats = this.activeCategories;
    const items: SymbolQuickPickItem[] = [];

    // Current file symbols
    if (this.contextUri) {
      try {
        const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          this.contextUri,
        );
        if (docSymbols && docSymbols.length > 0) {
          const flat = flattenDocumentSymbols(docSymbols, this.contextUri);
          const filtered = flat.filter(s => matchesActiveCategories(s.kind, cats));
          if (filtered.length > 0) {
            items.push({ label: 'Current File', kind: vscode.QuickPickItemKind.Separator });
            for (const sym of filtered) {
              const line = sym.location.range.start.line + 1;
              const iconId = symbolKindToIconId(sym.kind);
              items.push({
                label: `$(${iconId}) ${sym.name}`,
                description: sym.containerName ? sym.containerName.split('/').pop() ?? '' : '',
                detail: `:${line}`,
                symbolInfo: sym,
                alwaysShow: true,
              });
            }
          }
        }
      } catch { /* language server not ready */ }
    }

    // Recent symbols
    const recent = this.ranker.getRecentSymbols();
    const filteredRecent = recent.filter(s => matchesActiveCategories(s.kind, cats));
    if (filteredRecent.length > 0) {
      items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
      for (const sym of filteredRecent) {
        const rel = vscode.workspace.asRelativePath(sym.location.uri);
        const line = sym.location.range.start.line + 1;
        const iconId = symbolKindToIconId(sym.kind);
        items.push({
          label: `$(${iconId}) ${sym.name}`,
          description: sym.containerName || '',
          detail: `${rel}:${line}`,
          symbolInfo: sym,
          alwaysShow: true,
        });
      }
    }

    if (this.quickPick) this.quickPick.items = items;
  }

  private async onAccepted(): Promise<void> {
    const selected = this.quickPick?.selectedItems[0];
    if (!selected) return;

    if (selected.fileUri) {
      this.quickPick?.hide();
      const doc = await vscode.workspace.openTextDocument(selected.fileUri);
      await vscode.window.showTextDocument(doc, { preview: false });
      return;
    }

    if (!selected.symbolInfo) return;
    const loc = selected.symbolInfo.location;
    this.ranker.recordAccess(selected.symbolInfo);
    this.quickPick?.hide();

    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(loc.range.start, loc.range.start);
    editor.revealRange(loc.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private cleanup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.currentCts) {
      this.currentCts.cancel();
      this.currentCts.dispose();
      this.currentCts = undefined;
    }
    if (this.quickPick) {
      this.quickPick.dispose();
      this.quickPick = undefined;
    }
    this.isDepSearch = false;
    this.depSymbolCache = undefined;
  }

  dispose(): void {
    this.cleanup();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const FILE_SEARCH_EXCLUDE_DIRS: Record<WorkspaceLanguageId, string[]> = {
  go:         ['.git', 'vendor', 'testdata', 'dist', 'out'],
  rust:       ['.git', 'target', 'dist', 'out'],
  java:       ['.git', 'target', 'build', 'out', '.gradle', '.idea'],
  kotlin:     ['.git', 'build', 'out', '.gradle', '.idea'],
  typescript: ['.git', 'node_modules', 'dist', 'out', 'build', 'coverage'],
  javascript: ['.git', 'node_modules', 'dist', 'out', 'build', 'coverage'],
  python:     ['.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.eggs'],
  csharp:     ['.git', 'bin', 'obj', 'node_modules', 'packages'],
  unknown:    ['.git', 'node_modules', 'vendor', 'dist', 'out', 'target', 'coverage'],
};

function getFileSearchExcludePattern(langId: WorkspaceLanguageId): string {
  const dirs = FILE_SEARCH_EXCLUDE_DIRS[langId];
  return `**/{${dirs.join(',')}}/**`;
}

function toInsensitiveGlob(s: string): string {
  let out = '';
  for (const ch of s) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo !== up) {
      out += `[${lo}${up}]`;
    } else {
      out += ch.replace(/[[\]{}?*]/g, '\\$&');
    }
  }
  return out;
}

function buildTitle(categories: SymbolCategory[]): string {
  if (categories.length === 1 && categories[0] === SymbolCategory.Function) {
    return 'Search Function / Method';
  }
  if (categories.some(c => c === SymbolCategory.Class || c === SymbolCategory.Interface || c === SymbolCategory.Enum)) {
    return 'Search Type';
  }
  return 'Search Symbol';
}

function buildPlaceholder(categories: SymbolCategory[]): string {
  if (categories.length === 1 && categories[0] === SymbolCategory.Function) {
    return 'Type to search functions and methods';
  }
  if (categories.some(c => c === SymbolCategory.Class || c === SymbolCategory.Interface || c === SymbolCategory.Enum)) {
    return 'Type to search classes, interfaces, and enums';
  }
  return 'Type to search symbols';
}

function matchesActiveCategories(kind: vscode.SymbolKind, categories: SymbolCategory[]): boolean {
  if (categories.length === 0) return true;

  if (isStrictTypeSearch(categories)) {
    return matchesTypeSearchKind(kind, categories);
  }

  return categories.includes(symbolKindToCategory(kind));
}

function isStrictTypeSearch(categories: SymbolCategory[]): boolean {
  return categories.length > 0
    && categories.every(category =>
      category === SymbolCategory.Class
      || category === SymbolCategory.Interface
      || category === SymbolCategory.Enum,
    );
}

function matchesTypeSearchKind(kind: vscode.SymbolKind, categories: SymbolCategory[]): boolean {
  if (categories.includes(SymbolCategory.Class)) {
    if (kind === vscode.SymbolKind.Class || kind === vscode.SymbolKind.Struct || kind === vscode.SymbolKind.TypeParameter) {
      return true;
    }
  }
  if (categories.includes(SymbolCategory.Interface) && kind === vscode.SymbolKind.Interface) {
    return true;
  }
  if (categories.includes(SymbolCategory.Enum) && kind === vscode.SymbolKind.Enum) {
    return true;
  }
  return false;
}

function flattenDocumentSymbols(
  symbols: vscode.DocumentSymbol[],
  uri: vscode.Uri,
  container?: string,
): vscode.SymbolInformation[] {
  const result: vscode.SymbolInformation[] = [];
  for (const sym of symbols) {
    result.push(new vscode.SymbolInformation(
      sym.name,
      sym.kind,
      container ?? '',
      new vscode.Location(uri, sym.selectionRange),
    ));
    if (sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children, uri, sym.name));
    }
  }
  return result;
}
