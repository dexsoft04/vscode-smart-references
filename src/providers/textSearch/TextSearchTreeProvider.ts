import * as vscode from 'vscode';
import {
  SearchNode, TextSearchRequest, TextSearchOptions, TextSearchMatch,
  TextSearchGroupingMode, TextSearchViewState, TextSearchReplaceTarget,
} from './types';
import { SectionNode, WorkspaceNode, FileNode, MatchNode, ContextLineNode } from './nodes';
import {
  clamp, normalizeGlobs, dedupeStrings, globToRegex,
  collectExcludeRules, readConfiguredContextLineCounts, createDefaultSearchRequest,
  buildTextSearchTitle,
} from './utils';
import { TextSearchExcludeRule } from './types';
import { executeFixedRgSearch } from './ripgrepRunner';
import { executeFuzzySearch, filterExcludedPaths } from './fuzzySearch';
import { enrichMatches } from './matchEnrichment';
import { groupMatchesByWorkspace, groupMatchesByFile, buildSectionBuckets, buildSerializedSections } from './searchGrouping';

export function loadTextSearchOptions(request: TextSearchRequest | undefined, groupingOverride?: { groupCodeAndComments: boolean; groupConfigAndCodeFiles: boolean }): TextSearchOptions {
  const config = vscode.workspace.getConfiguration('smartReferences');
  const searchConfig = vscode.workspace.getConfiguration('search');
  const filesConfig = vscode.workspace.getConfiguration('files');
  const configuredContextLines = readConfiguredContextLineCounts(config);
  const runtimeRequest = request ?? createDefaultSearchRequest(
    config.get<boolean>('textSearch.fuzzySearch', false) ?? false,
    configuredContextLines.beforeContextLines,
    configuredContextLines.afterContextLines,
  );

  const searchExcludeRules = collectExcludeRules(searchConfig.get('exclude'));
  const filesExcludeRules = collectExcludeRules(filesConfig.get('exclude'));
  const customExcludeRules: TextSearchExcludeRule[] = normalizeGlobs(config.get('textSearch.excludeGlobs', [])).map(pattern => ({
    pattern,
    regex: globToRegex(pattern),
    when: undefined,
  }));
  const runtimeExcludeRules: TextSearchExcludeRule[] = normalizeGlobs(runtimeRequest.exclude).map(pattern => ({
    pattern,
    regex: globToRegex(pattern),
    when: undefined,
  }));
  const excludeRules = [...searchExcludeRules, ...filesExcludeRules, ...customExcludeRules, ...runtimeExcludeRules];

  return {
    beforeContextLines: clamp(runtimeRequest.beforeContextLines, 0, 20),
    afterContextLines: clamp(runtimeRequest.afterContextLines, 0, 20),
    includeGlobs: dedupeStrings([
      ...normalizeGlobs(config.get('textSearch.includeGlobs', [])),
      ...normalizeGlobs(runtimeRequest.include),
    ]),
    excludeGlobs: dedupeStrings(excludeRules.filter(rule => !rule.when).map(rule => rule.pattern)),
    excludeRules,
    fuzzySearch: runtimeRequest.fuzzySearch,
    useRegExp: runtimeRequest.useRegExp,
    matchCase: runtimeRequest.matchCase,
    matchWholeWord: runtimeRequest.matchWholeWord,
    smartCase: searchConfig.get<boolean>('smartCase', false) ?? false,
    groupCodeAndComments: groupingOverride?.groupCodeAndComments ?? (config.get<boolean>('textSearch.groupCodeAndComments', false) ?? false),
    groupConfigAndCodeFiles: groupingOverride?.groupConfigAndCodeFiles ?? (config.get<boolean>('textSearch.groupConfigAndCodeFiles', false) ?? false),
    useIgnoreFiles: searchConfig.get<boolean>('useIgnoreFiles', true) ?? true,
    useGlobalIgnoreFiles: searchConfig.get<boolean>('useGlobalIgnoreFiles', true) ?? true,
    useParentIgnoreFiles: searchConfig.get<boolean>('useParentIgnoreFiles', true) ?? true,
    followSymlinks: searchConfig.get<boolean>('followSymlinks', true) ?? true,
    maxFuzzyFileScan: clamp(config.get<number>('textSearch.maxFuzzyFileScan', 2000) ?? 2000, 100, 20000),
    maxFuzzyMatches: clamp(config.get<number>('textSearch.maxFuzzyMatches', 1000) ?? 1000, 50, 20000),
  };
}

async function executeSearch(query: string, options: TextSearchOptions, token?: vscode.CancellationToken): Promise<{ matches: TextSearchMatch[]; warning?: string }> {
  if (options.fuzzySearch) {
    const fuzzy = await executeFuzzySearch(query, options, token);
    return {
      matches: await enrichMatches(fuzzy.matches, options),
      warning: fuzzy.warning,
    };
  }

  const rawMatches = await executeFixedRgSearch(query, options, token);
  const filteredMatches = filterExcludedPaths(rawMatches, options, match => ({
    relativePath: match.relativePath,
    folderPath: match.workspaceUri.fsPath,
  }));
  return {
    matches: await enrichMatches(filteredMatches, options),
  };
}

export class TextSearchTreeProvider implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SearchNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private query = '';
  private request: TextSearchRequest | undefined;
  private matches: TextSearchMatch[] = [];
  private options = loadTextSearchOptions(undefined);
  private groupingOverride?: { groupCodeAndComments: boolean; groupConfigAndCodeFiles: boolean };
  private lastWarning?: string;
  private activeSearchTokenSource?: vscode.CancellationTokenSource;
  private activeSearchRunId = 0;

  getTreeItem(element: SearchNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SearchNode): Promise<SearchNode[]> {
    if (!element) {
      const sections = buildSectionBuckets(this.matches, this.options);
      if (sections.length > 0) return sections.map(bucket => new SectionNode(bucket));
      return this.buildWorkspaceOrFileNodes(this.matches);
    }
    if (element instanceof SectionNode) {
      return this.buildWorkspaceOrFileNodes(element.bucket.matches);
    }
    if (element instanceof WorkspaceNode) {
      return groupMatchesByFile(element.bucket.matches).map(bucket => new FileNode(bucket));
    }
    if (element instanceof FileNode) {
      return element.bucket.matches
        .slice()
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map(match => new MatchNode(match));
    }
    if (element instanceof MatchNode) {
      return [
        ...element.match.beforeLines.map(line => new ContextLineNode(element.match, line, 'before')),
        new ContextLineNode(
          element.match,
          { lineNumber: element.match.lineNumber, text: element.match.lineText },
          'current',
        ),
        ...element.match.afterLines.map(line => new ContextLineNode(element.match, line, 'after')),
      ];
    }
    return [];
  }

  private buildWorkspaceOrFileNodes(matches: TextSearchMatch[]): SearchNode[] {
    const workspaces = groupMatchesByWorkspace(matches);
    if (workspaces.length === 1) {
      return groupMatchesByFile(workspaces[0].matches).map(bucket => new FileNode(bucket));
    }
    return workspaces.map(bucket => new WorkspaceNode(bucket));
  }

  getTitle(): string {
    return buildTextSearchTitle(this.query, this.request, this.lastWarning);
  }

  hasResults(): boolean {
    return this.matches.length > 0;
  }

  getMatchCount(): number {
    return this.matches.length;
  }

  getFileCount(): number {
    return new Set(this.matches.map(m => m.uri.toString())).size;
  }

  getQuery(): string {
    return this.query;
  }

  getSearchRequest(): TextSearchRequest | undefined {
    return this.request;
  }

  getEditableRequest(): TextSearchRequest {
    const current = this.request ?? createDefaultSearchRequest(
      this.options.fuzzySearch,
      this.options.beforeContextLines,
      this.options.afterContextLines,
    );
    return { ...current };
  }

  getOrderedReplaceTargets(filters?: { targetKey?: string; sectionKey?: string; fileUri?: string }): TextSearchReplaceTarget[] {
    const sections = buildSerializedSections(this.matches, this.options);
    const targets = sections.flatMap(section => section.files.flatMap(file => file.matches.map(match => ({
      key: match.key,
      uri: match.uri,
      sectionKey: section.key,
      relativePath: file.relativePath,
      lineNumber: match.lineNumber,
      matchedText: match.matchedText,
      startLine: match.startLine,
      startCharacter: match.startCharacter,
      endLine: match.endLine,
      endCharacter: match.endCharacter,
    }))));
    return targets.filter(target => {
      if (filters?.targetKey && target.key !== filters.targetKey) return false;
      if (filters?.sectionKey && target.sectionKey !== filters.sectionKey) return false;
      if (filters?.fileUri && target.uri !== filters.fileUri) return false;
      return true;
    });
  }

  isFuzzySearchEnabled(): boolean {
    return this.options.fuzzySearch;
  }

  getLastWarning(): string | undefined {
    return this.lastWarning;
  }

  getViewState(): TextSearchViewState {
    const sections = buildSerializedSections(this.matches, this.options);
    const totalFiles = sections.reduce((sum, section) => sum + section.fileCount, 0);
    return {
      title: this.getTitle(),
      request: this.request ?? createDefaultSearchRequest(this.options.fuzzySearch, this.options.beforeContextLines, this.options.afterContextLines),
      warning: this.lastWarning,
      groupingMode: this.getGroupingMode(),
      totalMatches: this.matches.length,
      totalFiles,
      sections,
    };
  }

  getGroupingMode(): TextSearchGroupingMode {
    if (this.options.groupCodeAndComments && this.options.groupConfigAndCodeFiles) return 'both';
    if (this.options.groupCodeAndComments) return 'content';
    if (this.options.groupConfigAndCodeFiles) return 'fileKind';
    return 'none';
  }

  setGroupingMode(mode: TextSearchGroupingMode): void {
    this.groupingOverride = mode === 'none'
      ? { groupCodeAndComments: false, groupConfigAndCodeFiles: false }
      : mode === 'content'
        ? { groupCodeAndComments: true, groupConfigAndCodeFiles: false }
        : mode === 'fileKind'
          ? { groupCodeAndComments: false, groupConfigAndCodeFiles: true }
          : { groupCodeAndComments: true, groupConfigAndCodeFiles: true };
    this.options = loadTextSearchOptions(this.request, this.groupingOverride);
    this.onDidChangeTreeDataEmitter.fire();
  }

  clear(): void {
    this.cancelActiveSearch();
    this.query = '';
    this.request = undefined;
    this.matches = [];
    this.lastWarning = undefined;
    this.options = loadTextSearchOptions(undefined, this.groupingOverride);
    this.onDidChangeTreeDataEmitter.fire();
  }

  private beginSearch(token?: vscode.CancellationToken): {
    runId: number;
    token: vscode.CancellationToken;
    dispose: () => void;
  } {
    this.cancelActiveSearch();
    const source = new vscode.CancellationTokenSource();
    this.activeSearchTokenSource = source;
    const runId = ++this.activeSearchRunId;
    const forwardExternalCancellation = token?.onCancellationRequested(() => source.cancel());
    if (token?.isCancellationRequested) source.cancel();

    return {
      runId,
      token: source.token,
      dispose: () => {
        forwardExternalCancellation?.dispose();
        if (this.activeSearchTokenSource === source) this.activeSearchTokenSource = undefined;
        source.dispose();
      },
    };
  }

  private cancelActiveSearch(): void {
    this.activeSearchTokenSource?.cancel();
    this.activeSearchTokenSource?.dispose();
    this.activeSearchTokenSource = undefined;
  }

  private isSearchCancelled(err: unknown): boolean {
    return String(err) === 'Error: Text search cancelled' || String(err) === 'Text search cancelled';
  }

  async search(request: TextSearchRequest, token?: vscode.CancellationToken): Promise<boolean> {
    const normalizedQuery = request.query.trim();
    const normalizedRequest: TextSearchRequest = {
      ...request,
      query: normalizedQuery,
      replaceText: request.replaceText,
      include: request.include.trim(),
      exclude: request.exclude.trim(),
      beforeContextLines: clamp(request.beforeContextLines, 0, 20),
      afterContextLines: clamp(request.afterContextLines, 0, 20),
    };
    this.options = loadTextSearchOptions(normalizedRequest, this.groupingOverride);
    if (!normalizedQuery) {
      this.clear();
      return false;
    }
    const run = this.beginSearch(token);
    try {
      const result = await executeSearch(normalizedQuery, this.options, run.token);
      if (run.token.isCancellationRequested || run.runId !== this.activeSearchRunId) return false;
      this.query = normalizedQuery;
      this.request = normalizedRequest;
      this.matches = result.matches;
      this.lastWarning = result.warning;
      this.onDidChangeTreeDataEmitter.fire();
      return true;
    } catch (err) {
      if (run.token.isCancellationRequested || this.isSearchCancelled(err)) return false;
      throw err;
    } finally {
      run.dispose();
    }
  }

  async refresh(token?: vscode.CancellationToken): Promise<boolean> {
    if (!this.request?.query) return false;
    return await this.search(this.request, token);
  }

  dispose(): void {
    this.cancelActiveSearch();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}
