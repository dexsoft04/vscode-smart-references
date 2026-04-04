import * as vscode from 'vscode';
import * as path from 'path';
import { ReferenceTreeProvider, ReferenceScopeFilter, ReferenceGroupingMode, PinnedReferenceResult, SerializedPin } from './providers/ReferenceTreeProvider';
import { ReferenceLensProvider } from './providers/ReferenceLensProvider';
import { ReferenceClassifier } from './core/ReferenceClassifier';
import { ReferenceCache } from './core/Cache';
import { TestFileDetector } from './analyzers/TestFileDetector';
import { ReferencePreviewManager } from './providers/ReferencePreviewManager';
import { TextSearchTreeProvider, TextSearchGroupingMode, TextSearchRequest, TextSearchReplaceTarget } from './providers/TextSearchTreeProvider';
import { TypeHierarchyTreeProvider } from './providers/TypeHierarchyTreeProvider';
import { CategoryDecorationProvider } from './providers/CategoryDecorationProvider';
import { SymbolSearchProvider } from './providers/SymbolSearchProvider';
import { GoModLinkProvider } from './providers/GoModLinkProvider';
import { DependencyTreeProvider } from './providers/DependencyTreeProvider';
import { GoModResolver } from './core/DependencyResolver';
import { GoDepSymbolIndexer, DepSymbolIndexer } from './core/GoDepSymbolIndexer';
import { CSharpDependencyResolver } from './core/CSharpDependencyResolver';
import { CSharpDepSymbolIndexer } from './core/CSharpDepSymbolIndexer';
import { CSharpUsingLinkProvider } from './providers/CSharpUsingLinkProvider';
import { CSharpDefinitionProvider } from './providers/CSharpDefinitionProvider';
import { CSharpProjLinkProvider } from './providers/CSharpProjLinkProvider';
import { CSharpWorkspaceTypeIndexer } from './core/CSharpWorkspaceTypeIndexer';
import { PythonDependencyResolver } from './core/PythonDependencyResolver';
import { PythonDepSymbolIndexer } from './core/PythonDepSymbolIndexer';
import { PythonImportLinkProvider } from './providers/PythonImportLinkProvider';
import { NodeDependencyResolver } from './core/NodeDependencyResolver';
import { NodeDepSymbolIndexer } from './core/NodeDepSymbolIndexer';
import { SymbolCategory } from './core/SymbolRanker';
import { ProjectExplorerProvider, ProjectTestDecorationProvider, resolveRealUri, PROJ_TEST_SCHEME } from './providers/ProjectExplorerProvider';
import { StructureTreeProvider } from './providers/StructureTreeProvider';
import { ProjectViewMode } from './providers/ProjectExplorerGrouping';
import { ImplInlayHintsProvider } from './providers/ImplInlayHintsProvider';
import { TranslationManager } from './providers/TranslationManager';
import { ProtoWorkspaceNavigator } from './core/ProtoWorkspaceNavigator';
import { ProtoSymbolNavigationProvider } from './providers/ProtoSymbolNavigationProvider';
import { DEFAULT_TEXT_SEARCH_HISTORY_LIMIT, normalizeTextSearchHistoryLimit, pushTextSearchHistory, sanitizeTextSearchHistory } from './core/TextSearchHistory';
import { t } from './i18n';

export interface SmartReferencesExtensionApi {
  refreshProjectExplorer(force?: boolean): Promise<void>;
  getProjectExplorerState(): {
    currentViewMode: ProjectViewMode;
    availableViewModes: ProjectViewMode[];
  };
  setProjectExplorerViewMode(mode: ProjectViewMode): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): SmartReferencesExtensionApi {
  const outputChannel = vscode.window.createOutputChannel('IntelliJ-Style References');
  const TEXT_SEARCH_HISTORY_STORAGE_KEY = 'smartReferences.textSearchHistory';

  const cache = new ReferenceCache();
  const testDetector = new TestFileDetector();
  const protoNavigator = new ProtoWorkspaceNavigator(outputChannel);
  const classifier = new ReferenceClassifier(testDetector, cache, protoNavigator);
  const treeProvider = new ReferenceTreeProvider();
  treeProvider.setScopeAnchor(vscode.window.activeTextEditor?.document.uri);

  const PINS_STORAGE_KEY = 'smartReferences.pinnedResults';
  const savedPins = context.workspaceState.get<SerializedPin[]>(PINS_STORAGE_KEY, []);
  if (savedPins.length > 0) {
    try {
      treeProvider.loadPins(ReferenceTreeProvider.deserializePins(savedPins));
    } catch { /* ignore corrupted storage */ }
  }
  let pinPersistTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    treeProvider.onPinnedResultsChanged(() => {
      if (pinPersistTimer) clearTimeout(pinPersistTimer);
      pinPersistTimer = setTimeout(() => {
        void context.workspaceState.update(PINS_STORAGE_KEY, treeProvider.serializePins());
      }, 300);
    }),
  );
  const lensProvider = new ReferenceLensProvider(testDetector);
  const previewer = new ReferencePreviewManager();
  const textSearchProvider = new TextSearchTreeProvider();
  const getTextSearchHistoryLimit = (): number => normalizeTextSearchHistoryLimit(
    vscode.workspace.getConfiguration('smartReferences').get<number>('textSearch.historySize', DEFAULT_TEXT_SEARCH_HISTORY_LIMIT),
  );
  let textSearchHistory = sanitizeTextSearchHistory(
    context.workspaceState.get<string[]>(TEXT_SEARCH_HISTORY_STORAGE_KEY, []),
    getTextSearchHistoryLimit(),
  );
  void context.workspaceState.update(TEXT_SEARCH_HISTORY_STORAGE_KEY, textSearchHistory);

  const hierarchyProvider = new TypeHierarchyTreeProvider(testDetector);
  const symbolSearch = new SymbolSearchProvider(previewer, testDetector, outputChannel, protoNavigator);
  const goModLinkProvider = new GoModLinkProvider(outputChannel);
  const protoSymbolNavigationProvider = new ProtoSymbolNavigationProvider(protoNavigator);

  // Dependency tree
  const goModResolver = new GoModResolver();
  const csharpResolver = new CSharpDependencyResolver();
  const pythonResolver = new PythonDependencyResolver();
  const nodeResolver = new NodeDependencyResolver();
  const depProvider = new DependencyTreeProvider([nodeResolver, goModResolver, pythonResolver, csharpResolver], outputChannel);
  const depTreeView = vscode.window.createTreeView('dependencyTree', {
    treeDataProvider: depProvider,
    showCollapseAll: true,
  });

  // Dependency symbol indexer (composite: Node + Go + C# + Python)
  const nodeDepIndexer = new NodeDepSymbolIndexer(outputChannel);
  const goDepIndexer = new GoDepSymbolIndexer(outputChannel);
  const csharpDepIndexer = new CSharpDepSymbolIndexer(outputChannel);
  const pythonDepIndexer = new PythonDepSymbolIndexer(outputChannel);
  const compositeDepIndexer: DepSymbolIndexer = {
    invalidate() {
      nodeDepIndexer.invalidate();
      goDepIndexer.invalidate();
      csharpDepIndexer.invalidate();
      pythonDepIndexer.invalidate();
    },
    async getSymbols() {
      const [nodeSyms, goSyms, csSyms, pySyms] = await Promise.all([
        nodeDepIndexer.getSymbols(),
        goDepIndexer.getSymbols(),
        csharpDepIndexer.getSymbols(),
        pythonDepIndexer.getSymbols(),
      ]);
      return [...nodeSyms, ...goSyms, ...csSyms, ...pySyms];
    },
    dispose() {
      nodeDepIndexer.dispose();
      goDepIndexer.dispose();
      csharpDepIndexer.dispose();
      pythonDepIndexer.dispose();
    },
  };
  symbolSearch.setDepIndexer(compositeDepIndexer);

  // C# using link provider
  const csharpUsingLinkProvider = new CSharpUsingLinkProvider(outputChannel);

  // C# workspace type indexer (shared by definition provider)
  const csharpWsTypeIndexer = new CSharpWorkspaceTypeIndexer(outputChannel);

  // C# definition provider (F12 / Ctrl+Click on type names)
  const csharpDefinitionProvider = new CSharpDefinitionProvider(outputChannel, csharpWsTypeIndexer, csharpDepIndexer);

  // C# .csproj PackageReference link provider
  const csharpProjLinkProvider = new CSharpProjLinkProvider(outputChannel);

  // Python import link provider
  const pythonImportLinkProvider = new PythonImportLinkProvider(outputChannel);

  const refreshDepsView = () => {
    depProvider.refresh().catch(err => outputChannel.appendLine(`[dep-tree] refresh error: ${String(err)}`));
  };
  const markDepsDirty = () => {
    if (depTreeView.visible) {
      refreshDepsView();
    }
  };
  const depWatchers: vscode.FileSystemWatcher[] = [];
  const registerDepWatchers = (patterns: string[], onChange: () => void) => {
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidChange(onChange);
      watcher.onDidCreate(onChange);
      watcher.onDidDelete(onChange);
      depWatchers.push(watcher);
    }
  };

  const refreshGoDeps = () => {
    goDepIndexer.invalidate();
    csharpDefinitionProvider.invalidateDepCache();
    markDepsDirty();
  };

  const refreshCSharpDeps = () => {
    csharpDepIndexer.invalidate();
    csharpUsingLinkProvider.invalidateCache();
    csharpDefinitionProvider.invalidateDepCache();
    markDepsDirty();
  };

  const refreshPythonDeps = () => {
    pythonDepIndexer.invalidate();
    pythonImportLinkProvider.invalidateCache();
    csharpDefinitionProvider.invalidateDepCache();
    markDepsDirty();
  };

  const refreshNodeDeps = () => {
    nodeDepIndexer.invalidate();
    csharpDefinitionProvider.invalidateDepCache();
    markDepsDirty();
  };

  registerDepWatchers(goModResolver.watchPatterns, refreshGoDeps);
  registerDepWatchers(csharpResolver.watchPatterns, refreshCSharpDeps);
  registerDepWatchers(pythonResolver.watchPatterns, refreshPythonDeps);
  registerDepWatchers(nodeResolver.watchPatterns, refreshNodeDeps);

  // Watch .cs file changes → invalidate workspace type index
  const csFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
  const invalidateWsTypeIndex = () => csharpWsTypeIndexer.invalidate();
  csFileWatcher.onDidChange(invalidateWsTypeIndex);
  csFileWatcher.onDidCreate(invalidateWsTypeIndex);
  csFileWatcher.onDidDelete(invalidateWsTypeIndex);

  const depVisibilityListener = depTreeView.onDidChangeVisibility(e => {
    if (e.visible) {
      refreshDepsView();
    }
  });
  if (depTreeView.visible) {
    refreshDepsView();
  }

  // Project file explorer
  const projectExplorer = new ProjectExplorerProvider(testDetector, outputChannel);
  const projectExplorerView = vscode.window.createTreeView('projectExplorer', {
    treeDataProvider: projectExplorer,
    showCollapseAll: true,
  });
  const revealActiveProjectFile = async (uri?: vscode.Uri): Promise<void> => {
    if (!projectExplorerView.visible) return;
    const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!targetUri) return;
    const target = projectExplorer.getRevealTarget(targetUri);
    if (!target) return;
    try {
      await projectExplorerView.reveal(target, { select: true, focus: false, expand: true });
    } catch (err) {
      outputChannel.appendLine(`[project-explorer] reveal error: ${String(err)}`);
    }
  };
  // Title = workspace folder name + remote indicator (like native Explorer)
  const wsName = vscode.workspace.workspaceFolders?.[0]?.name;
  if (wsName) {
    let title = wsName;
    const remoteName = vscode.env.remoteName;
    if (remoteName === 'wsl') {
      const distro = process.env.WSL_DISTRO_NAME || 'Linux';
      title += ` [WSL: ${distro}]`;
    } else if (remoteName) {
      title += ` [${remoteName}]`;
    }
    projectExplorerView.title = title;
  }
  const updateProjectExplorerMessage = () => {
    projectExplorerView.message = projectExplorer.getStatusMessage() ?? '';
  };
  const projTestDecoration = vscode.window.registerFileDecorationProvider(new ProjectTestDecorationProvider());
  const projectExplorerStateListener = projectExplorer.onDidChangeTreeData(() => {
    updateProjectExplorerMessage();
  });
  updateProjectExplorerMessage();
  projectExplorer.setVisible(projectExplorerView.visible);
  const projectExplorerVisibilityListener = projectExplorerView.onDidChangeVisibility(e => {
    projectExplorer.setVisible(e.visible);
    if (e.visible) {
      void (async () => {
        await projectExplorer.refresh();
        await revealActiveProjectFile();
      })();
    }
  });

  // Dim Unity .meta files in the file explorer
  const metaFileDecor = vscode.window.registerFileDecorationProvider({
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
      if (uri.scheme !== 'file') return undefined;
      if (!uri.fsPath.endsWith('.meta')) return undefined;
      return {
        color: new vscode.ThemeColor('disabledForeground'),
        tooltip: 'Unity meta file',
      };
    },
  });

  // Native Explorer: dim test files with badge "T" (configurable)
  const nativeTestDecor = vscode.window.registerFileDecorationProvider({
    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
      if (!vscode.workspace.getConfiguration('smartReferences').get<boolean>('enableTestFileDecoration', true)) return undefined;
      if (uri.scheme !== 'file') return undefined;
      if (!testDetector.isTestFile(uri)) return undefined;
      return {
        badge: 'T',
        color: new vscode.ThemeColor('disabledForeground'),
        tooltip: 'Test file',
      };
    },
  });

  // Structure view (IntelliJ-style file structure)
  const structureProvider = new StructureTreeProvider();
  const structureView = vscode.window.createTreeView('structureTree', {
    treeDataProvider: structureProvider,
    showCollapseAll: true,
  });
  structureProvider.setTreeView(structureView);

  // Only load/track when Structure panel is visible
  const structureVisibilityListener = structureView.onDidChangeVisibility(e => {
    if (e.visible && vscode.window.activeTextEditor) {
      structureProvider.setDocument(vscode.window.activeTextEditor.document);
    }
  });
  const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(editor => {
    refreshReferenceTitle();
    if (structureView.visible && editor) structureProvider.setDocument(editor.document);
    if (editor) void revealActiveProjectFile(editor.document.uri);
    if (editor) scheduleRevealActiveReference(editor);
  });
  const docChangeListener = vscode.workspace.onDidChangeTextDocument(e => {
    if (structureView.visible && e.document === vscode.window.activeTextEditor?.document) {
      structureProvider.scheduleRefresh();
    }
  });
  const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(e => {
    if (structureView.visible && e.textEditor === vscode.window.activeTextEditor) {
      structureProvider.revealAtPosition(e.textEditor.selection.active);
    }
    if (e.textEditor === vscode.window.activeTextEditor) {
      scheduleRevealActiveReference(e.textEditor);
    }
  });

  // InlayHints: show "← N impls" inline at end of interface/struct lines
  const implHints = vscode.languages.registerInlayHintsProvider(
    { scheme: 'file' },
    new ImplInlayHintsProvider(),
  );

  const gitignoreWatcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
  const refreshProjectExplorer = () => projectExplorer.scheduleRefresh();
  gitignoreWatcher.onDidChange(refreshProjectExplorer);
  gitignoreWatcher.onDidCreate(refreshProjectExplorer);
  gitignoreWatcher.onDidDelete(refreshProjectExplorer);
  const fileCreateListener = vscode.workspace.onDidCreateFiles(refreshProjectExplorer);
  const fileDeleteListener = vscode.workspace.onDidDeleteFiles(refreshProjectExplorer);

  const goModLinks = vscode.languages.registerDocumentLinkProvider(
    { scheme: 'file', pattern: '**/go.mod' },
    goModLinkProvider,
  );
  const csharpLinks = vscode.languages.registerDocumentLinkProvider(
    { scheme: 'file', language: 'csharp' },
    csharpUsingLinkProvider,
  );
  const csharpDefRegistration = vscode.languages.registerDefinitionProvider(
    { scheme: 'file', language: 'csharp' },
    csharpDefinitionProvider,
  );
  const csharpProjLinks = vscode.languages.registerDocumentLinkProvider(
    { scheme: 'file', pattern: '**/*.csproj' },
    csharpProjLinkProvider,
  );
  const pythonLinks = vscode.languages.registerDocumentLinkProvider(
    { scheme: 'file', language: 'python' },
    pythonImportLinkProvider,
  );
  const protoDefinitions = vscode.languages.registerDefinitionProvider(
    { scheme: 'file', pattern: '**/*.proto' },
    protoSymbolNavigationProvider,
  );
  const protoReferences = vscode.languages.registerReferenceProvider(
    { scheme: 'file', pattern: '**/*.proto' },
    protoSymbolNavigationProvider,
  );
  const protoImplementations = vscode.languages.registerImplementationProvider(
    { scheme: 'file', pattern: '**/*.proto' },
    protoSymbolNavigationProvider,
  );
  const decorationProvider = vscode.window.registerFileDecorationProvider(new CategoryDecorationProvider());

  // Register tree views
  const treeView = vscode.window.createTreeView('smartReferencesTree', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  let refRevealTimer: ReturnType<typeof setTimeout> | undefined;
  const revealActiveReference = async (editor?: vscode.TextEditor): Promise<void> => {
    if (!treeView.visible) return;
    const activeEditor = editor ?? vscode.window.activeTextEditor;
    if (!activeEditor) return;
    const target = treeProvider.getRevealTarget(activeEditor.document.uri, activeEditor.selection.active);
    if (!target) return;
    try {
      await treeView.reveal(target, { select: false, focus: false, expand: true });
    } catch (err) {
      outputChannel.appendLine(`[references] reveal error: ${String(err)}`);
    }
  };
  const scheduleRevealActiveReference = (editor?: vscode.TextEditor): void => {
    if (refRevealTimer) clearTimeout(refRevealTimer);
    refRevealTimer = setTimeout(() => { void revealActiveReference(editor); }, 120);
  };
  const treeVisibilityListener = treeView.onDidChangeVisibility(e => {
    if (e.visible) scheduleRevealActiveReference();
  });
  const hierarchyView = vscode.window.createTreeView('typeHierarchyTree', {
    treeDataProvider: hierarchyProvider,
    showCollapseAll: true,
  });
  const textSearchView = vscode.window.createTreeView('textSearchTree', {
    treeDataProvider: textSearchProvider,
    showCollapseAll: true,
  });

  // Register CodeLens
  const lensRegistration = vscode.languages.registerCodeLensProvider(
    { scheme: 'file' },
    lensProvider,
  );

  // Main command: invoked from cursor position
  const findCmd = vscode.commands.registerCommand(
    'smartReferences.findReferences',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active editor');
        return;
      }
      await runFind(editor.document.uri, editor.selection.active);
    },
  );

  // Preview command: open file on the right, highlight reference line
  const previewCmd = vscode.commands.registerCommand(
    'smartReferences.previewReference',
    async (uri: vscode.Uri, range: vscode.Range) => {
      await previewer.preview(uri, range);
    },
  );

  // Internal command: invoked from CodeLens (passes uri + pos explicitly)
  const findAtCmd = vscode.commands.registerCommand(
    'smartReferences.findReferencesAt',
    async (uri: vscode.Uri, pos: vscode.Position) => {
      await runFind(uri, pos);
    },
  );

  async function runFind(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    treeProvider.setScopeAnchor(uri);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'IntelliJ-Style References: analyzing...',
      },
      async () => {
        try {
          const { symbolName, refs } = await classifier.classify(uri, position);
          if (refs.length === 0) {
            vscode.window.showInformationMessage('No references found');
            treeProvider.clear();
            refreshReferenceTitle();
            return;
          }
          treeProvider.setResults(symbolName, refs, uri);
          if (projectExplorer.getCurrentViewMode() === 'hotspot') {
            projectExplorer.updateHitCounts(treeProvider.getFileHitCounts());
          }
          refreshReferenceTitle();
          updateRefHistoryContext();
          scheduleRevealActiveReference(vscode.window.activeTextEditor);
          await vscode.commands.executeCommand('smartReferencesTree.focus');
        } catch (err) {
          vscode.window.showErrorMessage(`IntelliJ-Style References error: ${String(err)}`);
        }
      },
    );
  }

  // ── Shared implementation lookup ────────────────────────────────────────
  async function runTypeHierarchy(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Finding implementations...' },
      async () => {
        try {
          const locations = protoNavigator.isProtoUri(uri)
            ? await protoNavigator.findImplementations(uri, position)
            : await vscode.commands.executeCommand<vscode.Location[]>(
              'vscode.executeImplementationProvider',
              uri,
              position,
            ).then(result => Array.isArray(result) ? result : []);
          if (locations.length === 0) {
            vscode.window.showInformationMessage('No implementations found');
            hierarchyProvider.clear();
            hierarchyView.title = 'Implementations';
            return;
          }
          let symbolName = '';
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const wordRange = doc.getWordRangeAtPosition(position);
            if (wordRange) symbolName = doc.getText(wordRange);
          } catch { /* ignore */ }
          await hierarchyProvider.setResults(symbolName, locations);
          hierarchyView.title = hierarchyProvider.getSymbolLabel();
          updateImplHistoryContext();
          await vscode.commands.executeCommand('typeHierarchyTree.focus');
        } catch (err) {
          vscode.window.showErrorMessage(`Implementations error: ${String(err)}`);
        }
      },
    );
  }

  // Show Implementations command (same data as Ctrl+F12, better layout)
  const hierarchyCmd = vscode.commands.registerCommand(
    'smartReferences.showTypeHierarchy',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active editor');
        return;
      }
      await runTypeHierarchy(editor.document.uri, editor.selection.active);
    },
  );

  // Go to Implementation (from CodeLens): single → jump; multiple → tree
  const goToImplCmd = vscode.commands.registerCommand(
    'smartReferences.goToImplementation',
    async (uri: vscode.Uri, pos: vscode.Position, impls?: vscode.Location[]) => {
      if (!impls || impls.length === 0) return;
      if (impls.length === 1) {
        const target = impls[0];
        const doc = await vscode.workspace.openTextDocument(target.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(target.range.start, target.range.start);
      } else {
        await runTypeHierarchy(uri, pos);
      }
    },
  );

  // ── History navigation ──────────────────────────────────────────────────
  function updateRefHistoryContext(): void {
    vscode.commands.executeCommand('setContext', 'smartReferences.canGoBack', treeProvider.canGoBack());
    vscode.commands.executeCommand('setContext', 'smartReferences.canGoForward', treeProvider.canGoForward());
  }
  function refreshReferenceTitle(): void {
    treeView.title = treeProvider.getSymbolLabel() || 'References';
  }
  function updateImplHistoryContext(): void {
    vscode.commands.executeCommand('setContext', 'smartReferences.canImplGoBack', hierarchyProvider.canGoBack());
    vscode.commands.executeCommand('setContext', 'smartReferences.canImplGoForward', hierarchyProvider.canGoForward());
  }

  const prevRefCmd = vscode.commands.registerCommand('smartReferences.previousResult', () => {
    treeProvider.goBack();
    refreshReferenceTitle();
    updateRefHistoryContext();
    scheduleRevealActiveReference();
  });
  const nextRefCmd = vscode.commands.registerCommand('smartReferences.nextResult', () => {
    treeProvider.goForward();
    refreshReferenceTitle();
    updateRefHistoryContext();
    scheduleRevealActiveReference();
  });
  const prevImplCmd = vscode.commands.registerCommand('smartReferences.previousImpl', () => {
    hierarchyProvider.goBack();
    hierarchyView.title = hierarchyProvider.getSymbolLabel();
    updateImplHistoryContext();
  });
  const nextImplCmd = vscode.commands.registerCommand('smartReferences.nextImpl', () => {
    hierarchyProvider.goForward();
    hierarchyView.title = hierarchyProvider.getSymbolLabel();
    updateImplHistoryContext();
  });

  const isTextSearchCancelled = (err: unknown): boolean => {
    const message = String(err);
    return message === 'Error: Text search cancelled' || message === 'Text search cancelled';
  };
  let textSearchDraftRequest: TextSearchRequest = textSearchProvider.getEditableRequest();

  interface ReplacementFileContext {
    readonly uri: vscode.Uri;
    readonly originalText: string;
    readonly originalLineOffsets: number[];
    currentLineOffsets: number[];
    workingText: string;
    applied: Array<{ originalStart: number; delta: number }>;
  }

  interface ReplacementSessionOperation {
    readonly uri: string;
    readonly relativePath: string;
    readonly lineNumber: number;
    readonly appliedLineNumber: number;
    readonly matchedText: string;
    readonly replacementText: string;
  }

  interface ReplacementSessionFileSnapshot {
    readonly uri: string;
    readonly relativePath: string;
    readonly beforeText: string;
    readonly afterText: string;
  }

  interface ReplacementSessionRecord {
    readonly id: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly mode: 'single' | 'all';
    readonly query: string;
    readonly replaceText: string;
    readonly regex: boolean;
    readonly matchCase: boolean;
    readonly matchWholeWord: boolean;
    readonly appliedCount: number;
    readonly files: ReplacementSessionFileSnapshot[];
    readonly operations: ReplacementSessionOperation[];
    readonly stoppedReason?: string;
    undoneAt?: string;
  }

  const textSearchReplaceHistoryKey = 'smartReferences.textSearch.replaceHistory';
  const maxTextSearchReplaceHistory = 20;
  let textSearchReplaceHistory = context.workspaceState.get<ReplacementSessionRecord[]>(textSearchReplaceHistoryKey, []);

  const updateTextSearchUndoContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'smartReferences.canUndoTextSearchReplace',
      textSearchReplaceHistory.some(session => !session.undoneAt),
    );
  };

  const persistTextSearchReplaceHistory = async (): Promise<void> => {
    await context.workspaceState.update(textSearchReplaceHistoryKey, textSearchReplaceHistory);
    updateTextSearchUndoContext();
  };

  const appendTextSearchReplaceHistory = async (session: ReplacementSessionRecord): Promise<void> => {
    textSearchReplaceHistory = [session, ...textSearchReplaceHistory.filter(item => item.id !== session.id)].slice(0, maxTextSearchReplaceHistory);
    await persistTextSearchReplaceHistory();
  };

  const markTextSearchReplaceSessionUndone = async (sessionId: string): Promise<void> => {
    textSearchReplaceHistory = textSearchReplaceHistory.map(session => (
      session.id === sessionId ? { ...session, undoneAt: new Date().toISOString() } : session
    ));
    await persistTextSearchReplaceHistory();
  };

  const getLastUndoableTextSearchReplaceSession = (): ReplacementSessionRecord | undefined => (
    textSearchReplaceHistory.find(session => !session.undoneAt && session.appliedCount > 0)
  );

  const createTextSearchReplaceSessionId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const buildUndoReplaceDetail = (session: ReplacementSessionRecord): string => {
    const linesByFile = new Map<string, number[]>();
    for (const operation of session.operations) {
      const lines = linesByFile.get(operation.relativePath) ?? [];
      lines.push(operation.appliedLineNumber ?? operation.lineNumber);
      linesByFile.set(operation.relativePath, lines);
    }
    const entries = [...linesByFile.entries()]
      .map(([relativePath, lines]) => {
        const uniqueLines = [...new Set(lines)].sort((a, b) => a - b);
        const preview = uniqueLines.slice(0, 8).join(', ');
        const suffix = uniqueLines.length > 8
          ? t(` 等 ${uniqueLines.length} 行`, ` and ${uniqueLines.length - 8} more`)
          : '';
        return `${relativePath}: ${preview}${suffix}`;
      })
      .slice(0, 8);
    const extraFiles = linesByFile.size - entries.length;
    return [
      t('只有当这些文件仍保持该批替换后的内容时，才会执行安全回滚。', 'Safe rollback runs only when these files still match the post-replacement content from this batch.'),
      ...entries,
      ...(extraFiles > 0 ? [t(`其余 ${extraFiles} 个文件未展开。`, `${extraFiles} more files are not expanded.`)] : []),
    ].join('\n');
  };

  updateTextSearchUndoContext();

  const focusTextSearchView = async (): Promise<void> => {
    await vscode.commands.executeCommand('textSearchTree.focus');
  };

  const updateTextSearchOptionContexts = (): void => {
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchIncludeSet', Boolean(textSearchDraftRequest.include));
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchExcludeSet', Boolean(textSearchDraftRequest.exclude));
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchMatchCase', textSearchDraftRequest.matchCase);
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchWholeWord', textSearchDraftRequest.matchWholeWord);
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchRegex', textSearchDraftRequest.useRegExp);
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchFuzzy', textSearchDraftRequest.fuzzySearch);
  };

  updateTextSearchOptionContexts();

  const buildLineOffsets = (value: string): number[] => {
    const offsets = [0];
    for (let index = 0; index < value.length; index++) {
      if (value[index] === '\n') offsets.push(index + 1);
    }
    return offsets;
  };

  const offsetAt = (lineOffsets: number[], line: number, character: number): number => {
    return (lineOffsets[line] ?? lineOffsets[lineOffsets.length - 1] ?? 0) + character;
  };

  const getAdjustedOffset = (originalOffset: number, applied: Array<{ originalStart: number; delta: number }>): number => {
    let delta = 0;
    for (const change of applied) {
      if (change.originalStart < originalOffset) delta += change.delta;
    }
    return originalOffset + delta;
  };

  const positionAtOffset = (lineOffsets: number[], content: string, offset: number): vscode.Position => {
    const clampedOffset = Math.max(0, Math.min(offset, content.length));
    let low = 0;
    let high = lineOffsets.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (lineOffsets[mid] <= clampedOffset) low = mid;
      else high = mid - 1;
    }
    return new vscode.Position(low, clampedOffset - (lineOffsets[low] ?? 0));
  };

  const showTextSearchWarning = (): void => {
    const warning = textSearchProvider.getLastWarning();
    if (warning) void vscode.window.showWarningMessage(warning);
  };

  const createReplaceRegExp = (request: TextSearchRequest): RegExp | undefined => {
    if (!request.useRegExp) return undefined;
    const flags = request.matchCase ? 'u' : 'iu';
    return new RegExp(request.query, flags);
  };

  const applyReplacementText = (matchedText: string, request: TextSearchRequest): string => {
    if (!request.useRegExp) return request.replaceText;
    const regex = createReplaceRegExp(request);
    if (!regex) return request.replaceText;
    return matchedText.replace(regex, request.replaceText);
  };

  const formatLogValue = (value: string): string => value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

  const getReplacementFileContext = async (
    cache: Map<string, ReplacementFileContext>,
    uriText: string,
  ): Promise<ReplacementFileContext> => {
    const cached = cache.get(uriText);
    if (cached) return cached;
    const uri = vscode.Uri.parse(uriText);
    const document = await vscode.workspace.openTextDocument(uri);
    const originalText = document.getText();
    const initialLineOffsets = buildLineOffsets(originalText);
    const contextForFile: ReplacementFileContext = {
      uri,
      originalText,
      originalLineOffsets: initialLineOffsets,
      currentLineOffsets: initialLineOffsets,
      workingText: originalText,
      applied: [],
    };
    cache.set(uriText, contextForFile);
    return contextForFile;
  };

  const runTextSearch = async (request: TextSearchRequest): Promise<boolean> => {
    await focusTextSearchView();
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('搜索增强', 'Search Enhancement'), cancellable: true },
      async (_progress, token) => {
        try {
          const applied = await textSearchProvider.search(request, token);
          if (applied) {
            textSearchDraftRequest = { ...request };
            updateTextSearchOptionContexts();
            textSearchView.description = textSearchProvider.getTitle();
            showTextSearchWarning();
          }
          return applied;
        } catch (err) {
          if (isTextSearchCancelled(err)) return false;
          const message = String(err);
          if (message.includes('ENOENT')) {
            vscode.window.showErrorMessage(t('搜索增强需要系统 PATH 中可用的 ripgrep (`rg`)。', 'Search Enhancement requires ripgrep (`rg`) to be available in the system PATH.'));
          } else {
            vscode.window.showErrorMessage(`${t('搜索增强错误', 'Search Enhancement Error')}: ${message}`);
          }
          return false;
        }
      },
    );
  };

  const persistTextSearchHistory = async (): Promise<void> => {
    await context.workspaceState.update(TEXT_SEARCH_HISTORY_STORAGE_KEY, textSearchHistory);
  };

  const refreshTextSearchHistoryFromConfig = async (): Promise<void> => {
    const nextHistory = sanitizeTextSearchHistory(textSearchHistory, getTextSearchHistoryLimit());
    const unchanged = nextHistory.length === textSearchHistory.length
      && nextHistory.every((entry, index) => entry === textSearchHistory[index]);
    if (unchanged) return;
    textSearchHistory = nextHistory;
    await persistTextSearchHistory();
  };

  const appendTextSearchHistory = async (query: string): Promise<void> => {
    const nextHistory = pushTextSearchHistory(textSearchHistory, query, getTextSearchHistoryLimit());
    const unchanged = nextHistory.length === textSearchHistory.length
      && nextHistory.every((entry, index) => entry === textSearchHistory[index]);
    if (unchanged) return;
    textSearchHistory = nextHistory;
    await persistTextSearchHistory();
  };
  type ActiveTextSearchInputState = {
    inputBox: vscode.InputBox;
    historyIndex: number;
    draftValue: string;
  };
  let activeTextSearchInputState: ActiveTextSearchInputState | undefined;

  const setActiveTextSearchInputState = (state: ActiveTextSearchInputState | undefined): void => {
    activeTextSearchInputState = state;
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchInputActive', Boolean(state));
  };

  const applyTextSearchHistory = (direction: 'previous' | 'next'): void => {
    const state = activeTextSearchInputState;
    if (!state) return;
    const history = textSearchHistory;
    if (history.length === 0) return;
    if (direction === 'previous') {
      if (state.historyIndex === -1) state.draftValue = state.inputBox.value;
      if (state.historyIndex < history.length - 1) state.historyIndex += 1;
    } else {
      if (state.historyIndex === -1) return;
      state.historyIndex -= 1;
    }
    state.inputBox.value = state.historyIndex === -1
      ? state.draftValue
      : history[state.historyIndex];
  };

  const refreshTextSearchResults = async (showWarning = true): Promise<void> => {
    try {
      const applied = await textSearchProvider.refresh();
      if (applied) {
        textSearchDraftRequest = textSearchProvider.getEditableRequest();
        updateTextSearchOptionContexts();
        textSearchView.description = textSearchProvider.getTitle();
        if (showWarning) showTextSearchWarning();
      }
    } catch (err) {
      if (isTextSearchCancelled(err)) return;
      const message = String(err);
      if (message.includes('ENOENT')) {
        vscode.window.showErrorMessage(t('搜索增强需要系统 PATH 中可用的 ripgrep (`rg`)。', 'Search Enhancement requires ripgrep (`rg`) to be available in the system PATH.'));
      } else {
        vscode.window.showErrorMessage(`${t('搜索增强错误', 'Search Enhancement Error')}: ${message}`);
      }
    }
  };

  const promptReplaceText = async (initialValue: string): Promise<string | undefined> => {
    return await vscode.window.showInputBox({
      prompt: t('替换为', 'Replace with'),
      value: initialValue,
      ignoreFocusOut: true,
    });
  };

  const confirmTextSearchReplace = async (
    replaceText: string,
    detailLabel: string,
    confirmLabel: string,
  ): Promise<boolean> => {
    const answer = await vscode.window.showWarningMessage(
      `${t('确认将', 'Replace')} ${detailLabel} ${t('替换为', 'with')} ${JSON.stringify(replaceText)}?`,
      { modal: true, detail: t('替换会按当前显示顺序执行，遇到第一处失败立即停止。', 'Replacement runs in the current display order and stops at the first failure.') },
      confirmLabel,
    );
    return answer === confirmLabel;
  };

  const getCurrentTextSearchQuery = (): string => (textSearchProvider.getSearchRequest()?.query ?? textSearchDraftRequest.query).trim();
  const getTextSearchGroupingLabel = (mode: TextSearchGroupingMode = textSearchProvider.getGroupingMode()): string => (
    mode === 'none'
      ? t('无分组', 'No Grouping')
      : mode === 'content'
        ? t('代码 / 注释', 'Code / Comments')
        : mode === 'fileKind'
          ? t('代码 / 配置文件', 'Code / Config Files')
          : t('组合分组', 'Combined Grouping')
  );
  const applyTextSearchDraft = async (
    nextDraft: TextSearchRequest,
    successMessage?: string,
    queryOverride?: string,
  ): Promise<boolean> => {
    textSearchDraftRequest = nextDraft;
    updateTextSearchOptionContexts();
    const nextQuery = queryOverride !== undefined ? queryOverride.trim() : getCurrentTextSearchQuery();
    if (nextQuery) {
      return await runTextSearch({ ...nextDraft, query: nextQuery });
    }
    if (successMessage) void vscode.window.showInformationMessage(successMessage);
    return false;
  };

  const setTextSearchInclude = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const include = await vscode.window.showInputBox({
      prompt: t('包含文件 Glob，留空表示不限制', 'Include file glob. Leave empty for no extra limit.'),
      value: textSearchDraftRequest.include,
      ignoreFocusOut: true,
    });
    if (include === undefined) return false;
    const value = include.trim();
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, include: value },
      value ? `${t('搜索增强已设置包含文件', 'Search Enhancement include set')}: ${value}` : t('搜索增强已清除包含文件限制。', 'Search Enhancement include filter cleared.'),
      queryOverride,
    );
  };

  const setTextSearchExclude = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const exclude = await vscode.window.showInputBox({
      prompt: t('排除文件 Glob，留空表示不额外排除', 'Exclude file glob. Leave empty for no extra exclude.'),
      value: textSearchDraftRequest.exclude,
      ignoreFocusOut: true,
    });
    if (exclude === undefined) return false;
    const value = exclude.trim();
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, exclude: value },
      value ? `${t('搜索增强已设置排除文件', 'Search Enhancement exclude set')}: ${value}` : t('搜索增强已清除额外排除规则。', 'Search Enhancement extra exclude cleared.'),
      queryOverride,
    );
  };

  const toggleTextSearchMatchCase = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const before = textSearchDraftRequest.matchCase;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, matchCase: !textSearchDraftRequest.matchCase },
      before ? t('搜索增强已关闭区分大小写。', 'Search Enhancement match case disabled.') : t('搜索增强已开启区分大小写。', 'Search Enhancement match case enabled.'),
      queryOverride,
    );
  };

  const toggleTextSearchWholeWord = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    if (textSearchDraftRequest.fuzzySearch) {
      void vscode.window.showWarningMessage(t('模糊搜索不支持整词匹配，请先关闭模糊搜索。', 'Fuzzy search does not support whole-word matching. Turn off fuzzy search first.'));
      return false;
    }
    const before = textSearchDraftRequest.matchWholeWord;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, matchWholeWord: !textSearchDraftRequest.matchWholeWord },
      before ? t('搜索增强已关闭整词匹配。', 'Search Enhancement whole-word matching disabled.') : t('搜索增强已开启整词匹配。', 'Search Enhancement whole-word matching enabled.'),
      queryOverride,
    );
  };

  const toggleTextSearchRegex = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const before = textSearchDraftRequest.useRegExp;
    return await applyTextSearchDraft(
      {
        ...textSearchDraftRequest,
        useRegExp: !textSearchDraftRequest.useRegExp,
        fuzzySearch: !textSearchDraftRequest.useRegExp ? false : textSearchDraftRequest.fuzzySearch,
      },
      before ? t('搜索增强已关闭正则搜索。', 'Search Enhancement regex disabled.') : t('搜索增强已开启正则搜索。', 'Search Enhancement regex enabled.'),
      queryOverride,
    );
  };

  const toggleTextSearchFuzzy = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const before = textSearchDraftRequest.fuzzySearch;
    return await applyTextSearchDraft(
      {
        ...textSearchDraftRequest,
        fuzzySearch: !textSearchDraftRequest.fuzzySearch,
        useRegExp: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.useRegExp,
        matchWholeWord: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.matchWholeWord,
      },
      before ? t('搜索增强已关闭模糊搜索。', 'Search Enhancement fuzzy search disabled.') : t('搜索增强已开启模糊搜索。', 'Search Enhancement fuzzy search enabled.'),
      queryOverride,
    );
  };

  const setTextSearchGrouping = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const items: Array<{ label: string; description: string; mode: TextSearchGroupingMode }> = [
      { label: t('无分组', 'No Grouping'), description: t('按文件直接显示', 'Show directly by file'), mode: 'none' },
      { label: t('代码 / 注释', 'Code / Comments'), description: t('区分代码和注释命中', 'Separate code and comment matches'), mode: 'content' },
      { label: t('代码 / 配置文件', 'Code / Config Files'), description: t('区分代码文件和配置文件', 'Separate code files and config files'), mode: 'fileKind' },
      { label: t('组合分组', 'Combined Grouping'), description: t('同时按内容和文件类型分组', 'Group by content and file type together'), mode: 'both' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: t('选择搜索结果分组方式', 'Choose result grouping mode'),
      ignoreFocusOut: true,
    });
    if (!pick) return false;
    textSearchProvider.setGroupingMode(pick.mode);
    const nextQuery = queryOverride !== undefined ? queryOverride.trim() : getCurrentTextSearchQuery();
    if (nextQuery) {
      return await runTextSearch({ ...textSearchDraftRequest, query: nextQuery });
    }
    void vscode.window.showInformationMessage(`${t('搜索增强已切换分组', 'Search Enhancement grouping changed')}: ${getTextSearchGroupingLabel(pick.mode)}`);
    return true;
  };

  const configureTextSearch = async (queryOverride?: string): Promise<boolean> => {
    const items = [
      {
        label: t('包含的文件', 'Files to Include'),
        description: textSearchDraftRequest.include || t('全部文件', 'All files'),
        detail: t('设置要搜索的文件 glob，例如 src/**/*.ts', 'Set the file glob to search, for example src/**/*.ts'),
        action: 'include' as const,
      },
      {
        label: t('排除的文件', 'Files to Exclude'),
        description: textSearchDraftRequest.exclude || t('无额外排除', 'No extra exclude'),
        detail: t('设置要忽略的文件 glob，例如 **/*.spec.ts', 'Set the file glob to ignore, for example **/*.spec.ts'),
        action: 'exclude' as const,
      },
      {
        label: t('区分大小写', 'Match Case'),
        description: textSearchDraftRequest.matchCase ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('大小写必须完全一致', 'Letter case must match exactly'),
        action: 'matchCase' as const,
      },
      {
        label: t('整词匹配', 'Whole Word'),
        description: textSearchDraftRequest.matchWholeWord ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('只匹配完整单词边界', 'Match only complete word boundaries'),
        action: 'wholeWord' as const,
      },
      {
        label: t('正则搜索', 'Regex'),
        description: textSearchDraftRequest.useRegExp ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('使用正则表达式查找', 'Search using regular expressions'),
        action: 'regex' as const,
      },
      {
        label: t('模糊搜索', 'Fuzzy Search'),
        description: textSearchDraftRequest.fuzzySearch ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('按子序列模糊匹配，适合不完整关键词', 'Use subsequence fuzzy matching for incomplete keywords'),
        action: 'fuzzy' as const,
      },
      {
        label: t('结果分组', 'Grouping'),
        description: getTextSearchGroupingLabel(),
        detail: t('调整搜索结果的展示结构', 'Adjust how search results are grouped'),
        action: 'grouping' as const,
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: t('搜索选项', 'Search Options'),
      placeHolder: t('选择要调整的一项搜索设置', 'Choose one search setting to adjust'),
      ignoreFocusOut: true,
    });
    if (!pick) return false;
    if (pick.action === 'include') return await setTextSearchInclude(queryOverride);
    if (pick.action === 'exclude') return await setTextSearchExclude(queryOverride);
    if (pick.action === 'matchCase') return await toggleTextSearchMatchCase(queryOverride);
    if (pick.action === 'wholeWord') return await toggleTextSearchWholeWord(queryOverride);
    if (pick.action === 'regex') return await toggleTextSearchRegex(queryOverride);
    if (pick.action === 'fuzzy') return await toggleTextSearchFuzzy(queryOverride);
    return await setTextSearchGrouping(queryOverride);
  };

  const promptTextSearchQuery = async (initialValue: string): Promise<{ kind: string; query: string } | undefined> => {
    const inputBox = vscode.window.createInputBox();
    inputBox.title = t('搜索增强', 'Search Enhancement');
    inputBox.prompt = t('搜索内容', 'Search');
    inputBox.placeholder = t('输入要搜索的文本；可用上下方向键切换搜索历史', 'Enter text to search. Use Up/Down to browse search history.');
    inputBox.value = initialValue;
    inputBox.ignoreFocusOut = true;

    const createButtons = () => ({
      include: {
        iconPath: new vscode.ThemeIcon(textSearchDraftRequest.include ? 'filter-filled' : 'filter'),
        tooltip: `${t('包含文件', 'Include Files')}: ${textSearchDraftRequest.include || t('未设置', 'Not set')}`,
        location: vscode.QuickInputButtonLocation.Inline,
      },
      exclude: {
        iconPath: new vscode.ThemeIcon('exclude'),
        tooltip: `${t('排除文件', 'Exclude Files')}: ${textSearchDraftRequest.exclude || t('未设置', 'Not set')}`,
        location: vscode.QuickInputButtonLocation.Inline,
      },
      matchCase: {
        iconPath: new vscode.ThemeIcon('case-sensitive'),
        tooltip: t('区分大小写', 'Match Case'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.matchCase },
      },
      wholeWord: {
        iconPath: new vscode.ThemeIcon('whole-word'),
        tooltip: t('整词匹配', 'Whole Word'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.matchWholeWord },
      },
      regex: {
        iconPath: new vscode.ThemeIcon('regex'),
        tooltip: t('正则搜索', 'Regex'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.useRegExp },
      },
      fuzzy: {
        iconPath: new vscode.ThemeIcon('search-fuzzy'),
        tooltip: t('模糊搜索', 'Fuzzy Search'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.fuzzySearch },
      },
      grouping: {
        iconPath: new vscode.ThemeIcon('list-tree'),
        tooltip: `${t('结果分组', 'Grouping')}: ${getTextSearchGroupingLabel()}`,
        location: vscode.QuickInputButtonLocation.Inline,
      },
    });

    let buttons = createButtons();
    const buttonList = () => [
      buttons.include, buttons.exclude,
      buttons.matchCase, buttons.wholeWord, buttons.regex, buttons.fuzzy,
      buttons.grouping,
    ];
    inputBox.buttons = buttonList();

    const refreshButtons = () => {
      buttons = createButtons();
      inputBox.buttons = buttonList();
    };

    const applyOptionChange = () => {
      updateTextSearchOptionContexts();
      refreshButtons();
      const existingQuery = textSearchProvider.getSearchRequest()?.query?.trim();
      if (existingQuery) {
        void runTextSearch({ ...textSearchDraftRequest, query: existingQuery });
      }
    };

    const handleToggle = (button: vscode.QuickInputButton) => {
      if (button === buttons.fuzzy) {
        textSearchDraftRequest = {
          ...textSearchDraftRequest,
          fuzzySearch: !textSearchDraftRequest.fuzzySearch,
          useRegExp: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.useRegExp,
          matchWholeWord: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.matchWholeWord,
        };
      } else if (button === buttons.regex) {
        textSearchDraftRequest = {
          ...textSearchDraftRequest,
          useRegExp: !textSearchDraftRequest.useRegExp,
          fuzzySearch: !textSearchDraftRequest.useRegExp ? false : textSearchDraftRequest.fuzzySearch,
        };
      } else if (button === buttons.matchCase) {
        textSearchDraftRequest = { ...textSearchDraftRequest, matchCase: !textSearchDraftRequest.matchCase };
      } else if (button === buttons.wholeWord) {
        if (textSearchDraftRequest.fuzzySearch) {
          void vscode.window.showWarningMessage(t('模糊搜索不支持整词匹配，请先关闭模糊搜索。', 'Fuzzy search does not support whole-word matching. Turn off fuzzy search first.'));
          refreshButtons();
          return;
        }
        textSearchDraftRequest = { ...textSearchDraftRequest, matchWholeWord: !textSearchDraftRequest.matchWholeWord };
      }
      applyOptionChange();
    };

    const handleFilterInput = async (button: vscode.QuickInputButton) => {
      const isInclude = button === buttons.include;
      const currentValue = isInclude ? textSearchDraftRequest.include : textSearchDraftRequest.exclude;
      inputBox.hide();
      const glob = await vscode.window.showInputBox({
        prompt: isInclude
          ? t('包含文件 Glob，留空表示不限制', 'Include file glob. Leave empty for no extra limit.')
          : t('排除文件 Glob，留空表示不额外排除', 'Exclude file glob. Leave empty for no extra exclude.'),
        value: currentValue,
        ignoreFocusOut: true,
      });
      if (glob !== undefined) {
        const value = glob.trim();
        textSearchDraftRequest = isInclude
          ? { ...textSearchDraftRequest, include: value }
          : { ...textSearchDraftRequest, exclude: value };
        applyOptionChange();
      }
      refreshButtons();
      inputBox.show();
    };

    const handleGrouping = async () => {
      const items: Array<{ label: string; description: string; mode: TextSearchGroupingMode }> = [
        { label: t('无分组', 'No Grouping'), description: t('按文件直接显示', 'Show directly by file'), mode: 'none' },
        { label: t('代码 / 注释', 'Code / Comments'), description: t('区分代码和注释命中', 'Separate code and comment matches'), mode: 'content' },
        { label: t('代码 / 配置文件', 'Code / Config Files'), description: t('区分代码文件和配置文件', 'Separate code files and config files'), mode: 'fileKind' },
        { label: t('组合分组', 'Combined Grouping'), description: t('同时按内容和文件类型分组', 'Group by content and file type together'), mode: 'both' },
      ];
      inputBox.hide();
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: t('选择搜索结果分组方式', 'Choose result grouping mode'),
        ignoreFocusOut: true,
      });
      if (pick) {
        textSearchProvider.setGroupingMode(pick.mode);
        const existingQuery = textSearchProvider.getSearchRequest()?.query?.trim();
        if (existingQuery) {
          void runTextSearch({ ...textSearchDraftRequest, query: existingQuery });
        }
      }
      refreshButtons();
      inputBox.show();
    };

    return await new Promise(resolve => {
      let settled = false;
      const state: ActiveTextSearchInputState = {
        inputBox,
        historyIndex: -1,
        draftValue: initialValue,
      };
      setActiveTextSearchInputState(state);

      const finish = (result: { kind: string; query: string } | undefined) => {
        if (settled) return;
        settled = true;
        disposables.forEach(disposable => disposable.dispose());
        if (activeTextSearchInputState?.inputBox === inputBox) {
          setActiveTextSearchInputState(undefined);
        }
        inputBox.hide();
        inputBox.dispose();
        resolve(result);
      };
      const disposables: vscode.Disposable[] = [
        inputBox.onDidChangeValue(value => {
          state.historyIndex = -1;
          state.draftValue = value;
        }),
        inputBox.onDidAccept(() => finish({ kind: 'submit', query: inputBox.value })),
        inputBox.onDidTriggerButton(button => {
          if (button === buttons.matchCase || button === buttons.wholeWord
              || button === buttons.regex || button === buttons.fuzzy) {
            handleToggle(button);
          } else if (button === buttons.include || button === buttons.exclude) {
            void handleFilterInput(button);
          } else if (button === buttons.grouping) {
            void handleGrouping();
          }
        }),
        inputBox.onDidHide(() => finish(undefined)),
      ];
      inputBox.show();
    });
  };

  const executeTextSearchReplace = async (
    request: TextSearchRequest,
    targets: TextSearchReplaceTarget[],
    mode: 'single' | 'all',
  ): Promise<void> => {
    if (targets.length === 0) return;
    if (request.fuzzySearch) {
      void vscode.window.showWarningMessage(t('模糊搜索结果不支持替换。', 'Fuzzy search results do not support replacement.'));
      return;
    }

    const fileContexts = new Map<string, ReplacementFileContext>();
    const startedAt = new Date().toISOString();
    const sessionId = createTextSearchReplaceSessionId();
    const sessionOperations: ReplacementSessionOperation[] = [];
    let completed = 0;
    outputChannel.appendLine(`[text-search:replace] start id=${sessionId} ${startedAt} mode=${mode} files=${new Set(targets.map(target => target.uri)).size} matches=${targets.length}`);
    outputChannel.appendLine(`[text-search:replace] id=${sessionId} query=${JSON.stringify(request.query)} regex=${request.useRegExp} case=${request.matchCase} word=${request.matchWholeWord}`);

    const persistReplacementSession = async (stoppedReason?: string): Promise<ReplacementSessionRecord | undefined> => {
      if (completed === 0) return undefined;
      const files = [...fileContexts.values()]
        .filter(contextForFile => contextForFile.applied.length > 0)
        .map(contextForFile => ({
          uri: contextForFile.uri.toString(),
          relativePath: vscode.workspace.asRelativePath(contextForFile.uri, false),
          beforeText: contextForFile.originalText,
          afterText: contextForFile.workingText,
        }));
      const session: ReplacementSessionRecord = {
        id: sessionId,
        startedAt,
        completedAt: new Date().toISOString(),
        mode,
        query: request.query,
        replaceText: request.replaceText,
        regex: request.useRegExp,
        matchCase: request.matchCase,
        matchWholeWord: request.matchWholeWord,
        appliedCount: completed,
        files,
        operations: sessionOperations,
        stoppedReason,
      };
      await appendTextSearchReplaceHistory(session);
      outputChannel.appendLine(`[text-search:replace] stored id=${sessionId} applied=${completed} files=${files.length}${stoppedReason ? ` stopped=${JSON.stringify(stoppedReason)}` : ''}`);
      return session;
    };

    try {
      for (const target of targets) {
        const contextForFile = await getReplacementFileContext(fileContexts, target.uri);
        const originalStart = offsetAt(contextForFile.originalLineOffsets, target.startLine, target.startCharacter);
        const originalEnd = offsetAt(contextForFile.originalLineOffsets, target.endLine, target.endCharacter);
        const adjustedStart = getAdjustedOffset(originalStart, contextForFile.applied);
        const adjustedEnd = getAdjustedOffset(originalEnd, contextForFile.applied);
        const currentSlice = contextForFile.workingText.slice(adjustedStart, adjustedEnd);

        if (currentSlice !== target.matchedText) {
          const message = `stale match; expected=${JSON.stringify(target.matchedText)} actual=${JSON.stringify(currentSlice)}`;
          outputChannel.appendLine(`[text-search:replace] fail id=${sessionId} ${target.relativePath}:${target.lineNumber} ${message}`);
          throw new Error(`${t('替换已在', 'Replacement stopped at')} ${target.relativePath}:${target.lineNumber}: ${message}`);
        }

        const replacementText = applyReplacementText(currentSlice, request);
        const range = new vscode.Range(
          positionAtOffset(contextForFile.currentLineOffsets, contextForFile.workingText, adjustedStart),
          positionAtOffset(contextForFile.currentLineOffsets, contextForFile.workingText, adjustedEnd),
        );
        const edit = new vscode.WorkspaceEdit();
        edit.replace(contextForFile.uri, range, replacementText);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          const message = 'workspace.applyEdit returned false';
          outputChannel.appendLine(`[text-search:replace] fail id=${sessionId} ${target.relativePath}:${target.lineNumber} ${message}`);
          throw new Error(`${t('替换已在', 'Replacement stopped at')} ${target.relativePath}:${target.lineNumber}: ${message}`);
        }

        contextForFile.workingText = `${contextForFile.workingText.slice(0, adjustedStart)}${replacementText}${contextForFile.workingText.slice(adjustedEnd)}`;
        contextForFile.currentLineOffsets = buildLineOffsets(contextForFile.workingText);
        contextForFile.applied.push({ originalStart, delta: replacementText.length - currentSlice.length });
        sessionOperations.push({
          uri: target.uri,
          relativePath: target.relativePath,
          lineNumber: target.lineNumber,
          appliedLineNumber: range.start.line + 1,
          matchedText: currentSlice,
          replacementText,
        });
        completed += 1;
        outputChannel.appendLine(
          `[text-search:replace] ok id=${sessionId} ${target.relativePath}:${target.lineNumber} match=${JSON.stringify(formatLogValue(currentSlice))} replace=${JSON.stringify(formatLogValue(replacementText))}`,
        );
      }
      outputChannel.appendLine(`[text-search:replace] done id=${sessionId} mode=${mode} completed=${completed}/${targets.length}`);
      await persistReplacementSession();
      textSearchDraftRequest = { ...request };
      updateTextSearchOptionContexts();
      await refreshTextSearchResults(false);
      void vscode.window.showInformationMessage(mode === 'single' ? `${t('已替换 1 处命中', 'Replaced 1 match')} (ID: ${sessionId})` : `${t('已顺序替换', 'Sequentially replaced')} ${completed} ${t('处命中', 'matches')} (ID: ${sessionId})`);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      outputChannel.appendLine(`[text-search:replace] stopped id=${sessionId} completed=${completed}/${targets.length} reason=${message}`);
      await persistReplacementSession(message);
      await refreshTextSearchResults(false);
      void vscode.window.showErrorMessage(message);
    }
  };

  const undoLastTextSearchReplaceCmd = vscode.commands.registerCommand(
    'smartReferences.undoLastTextSearchReplace',
    async () => {
      await focusTextSearchView();
      const session = getLastUndoableTextSearchReplaceSession();
      if (!session) {
        void vscode.window.showInformationMessage(t('当前没有可撤销的搜索增强替换。', 'There is no undoable Search Enhancement replacement right now.'));
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        t(`撤销替换批次 ${session.id}，涉及 ${session.files.length} 个文件 / ${session.appliedCount} 处替换？`, `Undo replacement batch ${session.id} affecting ${session.files.length} files / ${session.appliedCount} matches?`),
        { modal: true, detail: buildUndoReplaceDetail(session) },
        t('撤销上次替换', 'Undo Last Replace'),
      );
      if (answer !== t('撤销上次替换', 'Undo Last Replace')) return;

      outputChannel.appendLine(`[text-search:undo] start id=${session.id} files=${session.files.length} applied=${session.appliedCount}`);
      outputChannel.appendLine(`[text-search:undo] id=${session.id} query=${JSON.stringify(session.query)} regex=${session.regex} case=${session.matchCase} word=${session.matchWholeWord}`);
      try {
        const edit = new vscode.WorkspaceEdit();
        for (const file of session.files) {
          const uri = vscode.Uri.parse(file.uri);
          const document = await vscode.workspace.openTextDocument(uri);
          const currentText = document.getText();
          if (currentText !== file.afterText) {
            const message = t(`文件已变化，无法安全撤销: ${file.relativePath}`, `File changed; cannot safely undo: ${file.relativePath}`);
            outputChannel.appendLine(`[text-search:undo] fail id=${session.id} ${message}`);
            throw new Error(message);
          }
          const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentText.length));
          edit.replace(uri, fullRange, file.beforeText);
        }

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          const message = 'workspace.applyEdit returned false';
          outputChannel.appendLine(`[text-search:undo] fail id=${session.id} ${message}`);
          throw new Error(`${t('撤销替换', 'Undo replace')} ${session.id} ${t('失败', 'failed')}: ${message}`);
        }

        for (const operation of [...session.operations].reverse()) {
          outputChannel.appendLine(
            `[text-search:undo] ok id=${session.id} ${operation.relativePath}:${operation.appliedLineNumber ?? operation.lineNumber} match=${JSON.stringify(formatLogValue(operation.replacementText))} replace=${JSON.stringify(formatLogValue(operation.matchedText))}`,
          );
        }

        await markTextSearchReplaceSessionUndone(session.id);
        outputChannel.appendLine(`[text-search:undo] done id=${session.id} files=${session.files.length} reverted=${session.operations.length}`);
        await refreshTextSearchResults(false);
        void vscode.window.showInformationMessage(`${t('已撤销替换批次', 'Reverted replacement batch')} ${session.id}`);
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        outputChannel.appendLine(`[text-search:undo] stopped id=${session.id} reason=${message}`);
        void vscode.window.showErrorMessage(message);
      }
    },
  );

  const searchAllCmd = vscode.commands.registerCommand(
    'smartReferences.searchSymbol',
    () => symbolSearch.show([]),
  );
  const searchFunctionCmd = vscode.commands.registerCommand(
    'smartReferences.searchFunction',
    () => symbolSearch.show([SymbolCategory.Function]),
  );
  const searchTypeCmd = vscode.commands.registerCommand(
    'smartReferences.searchType',
    () => symbolSearch.show([SymbolCategory.Class, SymbolCategory.Interface, SymbolCategory.Enum]),
  );
  const searchTextCmd = vscode.commands.registerCommand(
    'smartReferences.searchText',
    async () => {
      const editor = vscode.window.activeTextEditor;
      const selectedText = editor && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection).trim()
        : undefined;
      const seedQuery = selectedText || textSearchProvider.getSearchRequest()?.query || textSearchDraftRequest.query;
      const result = await promptTextSearchQuery(seedQuery);
      if (!result) return;
      const query = result.query;
      const request = { ...textSearchDraftRequest, query };
      if (!query.trim()) {
        textSearchProvider.clear();
        textSearchDraftRequest = { ...request, query: '' };
        updateTextSearchOptionContexts();
        textSearchView.description = '';
        await focusTextSearchView();
        return;
      }
      const applied = await runTextSearch(request);
      if (applied) {
        await appendTextSearchHistory(query);
      }
    },
  );
  const searchTextFromSelectionCmd = vscode.commands.registerCommand(
    'smartReferences.searchTextFromSelection',
    async () => {
      await vscode.commands.executeCommand('smartReferences.searchText');
    },
  );
  const editTextSearchCmd = vscode.commands.registerCommand(
    'smartReferences.editTextSearch',
    async () => {
      const seedQuery = textSearchProvider.getSearchRequest()?.query || textSearchDraftRequest.query;
      const result = await promptTextSearchQuery(seedQuery);
      if (!result) return;
      const query = result.query;
      const request = { ...textSearchDraftRequest, query };
      if (!query.trim()) {
        textSearchProvider.clear();
        textSearchDraftRequest = { ...request, query: '' };
        updateTextSearchOptionContexts();
        textSearchView.description = '';
        await focusTextSearchView();
        return;
      }
      const applied = await runTextSearch(request);
      if (applied) {
        await appendTextSearchHistory(query);
      }
    },
  );
  const previousTextSearchHistoryCmd = vscode.commands.registerCommand(
    'smartReferences.previousTextSearchHistory',
    () => {
      applyTextSearchHistory('previous');
    },
  );
  const nextTextSearchHistoryCmd = vscode.commands.registerCommand(
    'smartReferences.nextTextSearchHistory',
    () => {
      applyTextSearchHistory('next');
    },
  );
  const refreshTextSearchCmd = vscode.commands.registerCommand(
    'smartReferences.refreshTextSearch',
    async () => {
      await focusTextSearchView();
      if (!textSearchProvider.getSearchRequest()?.query) return;
      await refreshTextSearchResults();
    },
  );
  const configureTextSearchCmd = vscode.commands.registerCommand(
    'smartReferences.configureTextSearch',
    async () => {
      await configureTextSearch();
    },
  );

  const toggleTextSearchMatchCaseCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchMatchCase',
    async () => {
      await toggleTextSearchMatchCase();
    },
  );

  const toggleTextSearchWholeWordCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchWholeWord',
    async () => {
      await toggleTextSearchWholeWord();
    },
  );

  const toggleTextSearchRegexCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchRegex',
    async () => {
      await toggleTextSearchRegex();
    },
  );

  const setTextSearchIncludeCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchInclude',
    async () => {
      await setTextSearchInclude();
    },
  );

  const setTextSearchExcludeCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchExclude',
    async () => {
      await setTextSearchExclude();
    },
  );

  const toggleTextSearchFuzzyCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchFuzzy',
    async () => {
      await toggleTextSearchFuzzy();
    },
  );

  const setTextSearchGroupingCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchGrouping',
    async () => {
      await setTextSearchGrouping();
    },
  );
  const replaceAllTextSearchResultsCmd = vscode.commands.registerCommand(
    'smartReferences.replaceAllTextSearchResults',
    async () => {
      const targets = textSearchProvider.getOrderedReplaceTargets();
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前没有可替换的搜索结果。', 'There are no replaceable search results right now.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const fileCount = new Set(targets.map(target => target.uri)).size;
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        t(`${targets.length} 处命中（${fileCount} 个文件）`, `${targets.length} matches (${fileCount} files)`),
        t('全部替换', 'Replace All'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );
  const replaceTextSearchMatchCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchMatch',
    async (item?: any) => {
      const uri = item?.match?.uri?.toString?.() ?? item?.match?.uri?.toString?.call?.(item.match.uri);
      const range = item?.match?.range;
      if (!uri || !range) {
        vscode.window.showInformationMessage(t('请选择一条搜索命中再执行替换。', 'Select a search match before replacing.'));
        return;
      }
      const key = `${uri}#${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
      const targets = textSearchProvider.getOrderedReplaceTargets({ targetKey: key });
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前命中已失效，请先刷新搜索结果。', 'The current match is stale. Refresh the search results first.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        `${targets[0]?.relativePath ?? t('当前命中', 'Current Match')}:${targets[0]?.lineNumber ?? ''}`,
        t('替换当前命中', 'Replace Current Match'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'single');
    },
  );
  const replaceTextSearchSectionCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchSection',
    async (item?: any) => {
      const sectionKey = item?.bucket?.key;
      const sectionLabel = item?.bucket?.label ?? t('当前分组', 'Current Group');
      if (!sectionKey) {
        vscode.window.showInformationMessage(t('请选择一个搜索分组再执行替换。', 'Select a search group before replacing.'));
        return;
      }
      const targets = textSearchProvider.getOrderedReplaceTargets({ sectionKey });
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前分组没有可替换的搜索结果。', 'There are no replaceable search results in the current group.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const fileCount = new Set(targets.map(target => target.uri)).size;
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        t(`分组“${sectionLabel}”中的 ${targets.length} 处命中（${fileCount} 个文件）`, `${targets.length} matches in group "${sectionLabel}" (${fileCount} files)`),
        t('替换当前分组', 'Replace Current Group'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );
  const replaceTextSearchFileCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchFile',
    async (item?: any) => {
      const fileUri = item?.bucket?.uri?.toString?.() ?? item?.bucket?.uri?.toString?.call?.(item.bucket.uri);
      const relativePath = item?.bucket?.relativePath ?? t('当前文件', 'Current File');
      if (!fileUri) {
        vscode.window.showInformationMessage(t('请选择一个搜索文件节点再执行替换。', 'Select a search file before replacing.'));
        return;
      }
      const targets = textSearchProvider.getOrderedReplaceTargets({ fileUri });
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前文件没有可替换的搜索结果。', 'There are no replaceable search results in the current file.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        t(`文件“${relativePath}”中的 ${targets.length} 处命中`, `${targets.length} matches in file "${relativePath}"`),
        t('替换当前文件', 'Replace Current File'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );

  // Dependency commands
  const refreshStructureCmd = vscode.commands.registerCommand(
    'smartReferences.refreshStructure',
    async () => {
      await vscode.commands.executeCommand('structureTree.focus');
      return structureProvider.refresh();
    },
  );
  const showStructureCmd = vscode.commands.registerCommand(
    'smartReferences.showStructure',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await structureProvider.setDocument(editor.document);
      await vscode.commands.executeCommand('structureTree.focus');
    },
  );

  const refreshDepsCmd = vscode.commands.registerCommand(
    'smartReferences.refreshDeps',
    async () => {
      await vscode.commands.executeCommand('dependencyTree.focus');
      return depProvider.refresh();
    },
  );
  const searchDepsCmd = vscode.commands.registerCommand(
    'smartReferences.searchDeps',
    async () => {
      await vscode.commands.executeCommand('dependencyTree.focus');
      return depProvider.searchAndOpen();
    },
  );
  const searchDepSymbolsCmd = vscode.commands.registerCommand(
    'smartReferences.searchDependencySymbols',
    () => symbolSearch.showDepSymbolSearch(),
  );

  // Project explorer commands
  const refreshProjectCmd = vscode.commands.registerCommand(
    'smartReferences.refreshProjectExplorer',
    async () => {
      await vscode.commands.executeCommand('projectExplorer.focus');
      return projectExplorer.refresh(true);
    },
  );
  const toggleProjectViewCmd = vscode.commands.registerCommand(
    'smartReferences.toggleProjectViewMode',
    async () => {
      await vscode.commands.executeCommand('projectExplorer.focus');
      const modeLabels: Record<ProjectViewMode, { label: string; description: string }> = {
        'merged': {
          label: t('合并目录树', 'Merged Tree'),
          description: t('所有已跟踪文件共用一棵目录树。', 'All tracked files in one directory tree.'),
        },
        'categorized': {
          label: t('源码 / 测试', 'Sources / Tests'),
          description: t('按源码和测试拆分。', 'Split tracked files into sources and tests.'),
        },
        'cpp-project': {
          label: t('工程分组', 'Project Layout'),
          description: t('按模块、头文件、测试、工程文件、第三方依赖分组；多项目工作区会先按项目名分层。生成文件并入模块或头文件，并以 ignored 风格弱化显示。专用测试目录不弱化。', 'Group by modules, headers, tests, build files, and third-party code. Multi-project workspaces add a project-name layer first. Generated files stay under modules or headers and use ignored-style dimming. Dedicated test directories stay normal.'),
        },
        'hotspot': {
          label: t('热点文件', 'Hotspot Files'),
          description: t('按本次会话中引用查询命中频率排序，命中越多排越前。', 'Files sorted by how often they appeared in reference query results this session.'),
        },
      };
      const currentMode = projectExplorer.getCurrentViewMode();
      const picked = await vscode.window.showQuickPick(
        projectExplorer.getAvailableViewModes().map(mode => ({
          label: modeLabels[mode].label,
          description: modeLabels[mode].description,
          detail: mode === currentMode ? t('当前模式', 'Current mode') : undefined,
          mode,
        })),
        {
          title: t('项目文件分组模式', 'Project Files Grouping'),
          placeHolder: t('选择 Project Files 的显示方式', 'Choose how Project Files should be grouped'),
        },
      );
      if (!picked) return;
      // Refresh after confirmation to avoid wasted work when user cancels.
      // getAvailableViewModes() uses cached cppProjectDetected which is kept
      // current by file-watcher-driven scheduleRefresh, so the QuickPick list
      // shown above is already up-to-date in normal usage.
      await projectExplorer.refresh(true);
      projectExplorer.setViewMode(picked.mode);
      if (picked.mode === 'hotspot') {
        projectExplorer.updateHitCounts(treeProvider.getFileHitCounts());
      }
    },
  );
  const setReferenceScopeCmd = vscode.commands.registerCommand(
    'smartReferences.setReferenceScope',
    async (scope?: ReferenceScopeFilter) => {
      let nextScope = scope;
      if (!nextScope) {
        const picked = await vscode.window.showQuickPick([
          { label: 'All', description: '显示全部引用', value: 'all' as const },
          { label: 'Production', description: '仅显示生产代码引用', value: 'production' as const },
          { label: 'Tests', description: '仅显示测试代码引用', value: 'test' as const },
          { label: 'Current File', description: '仅显示发起查询文件中的引用', value: 'currentFile' as const },
          { label: 'Current Directory', description: '仅显示发起查询目录中的引用', value: 'currentDirectory' as const },
          { label: 'Workspace Source', description: '仅显示工作区源码，排除 .d.ts 和生成目录', value: 'workspaceSource' as const },
        ], {
          placeHolder: 'Filter reference results',
        });
        nextScope = picked?.value;
      }
      if (!nextScope) return;
      treeProvider.setScopeFilter(nextScope);
      refreshReferenceTitle();
      scheduleRevealActiveReference();
    },
  );
  const setReferenceGroupingCmd = vscode.commands.registerCommand(
    'smartReferences.setReferenceGrouping',
    async (mode?: ReferenceGroupingMode) => {
      let nextMode = mode;
      if (!nextMode) {
        const picked = await vscode.window.showQuickPick([
          { label: 'By Directory', description: '分类后按目录树分组', value: 'directory' as const },
          { label: 'By File', description: '分类后直接按文件分组', value: 'file' as const },
        ], {
          placeHolder: 'Group reference results',
        });
        nextMode = picked?.value;
      }
      if (!nextMode) return;
      treeProvider.setGroupingMode(nextMode);
      scheduleRevealActiveReference();
    },
  );
  const exportReferenceResultsCmd = vscode.commands.registerCommand(
    'smartReferences.exportResults',
    async () => {
      const md = treeProvider.formatAsMarkdown();
      if (!md) {
        vscode.window.showInformationMessage('No reference results to export.');
        return;
      }
      await vscode.env.clipboard.writeText(md);
      vscode.window.showInformationMessage('Reference results copied to clipboard as Markdown.');
    },
  );
  const filterReferenceKeywordCmd = vscode.commands.registerCommand(
    'smartReferences.filterReferenceKeyword',
    async () => {
      const current = treeProvider.getKeywordFilter();
      const keyword = await vscode.window.showInputBox({
        prompt: 'Filter references by keyword (leave empty to clear)',
        value: current,
        placeHolder: 'e.g. error, userId, handleXxx',
      });
      if (keyword !== undefined) {
        treeProvider.setKeywordFilter(keyword);
        refreshReferenceTitle();
      }
    },
  );
  const pinReferenceResultsCmd = vscode.commands.registerCommand(
    'smartReferences.pinReferenceResults',
    () => {
      const pinned = treeProvider.pinCurrentResults();
      if (!pinned) {
        vscode.window.showInformationMessage('No reference results to pin');
        return;
      }
      const action = pinned.isNew ? 'Pinned' : 'Updated pin for';
      vscode.window.showInformationMessage(`${action} "${pinned.entry.symbolName}"`);
    },
  );
  const openPinnedReferenceResultsCmd = vscode.commands.registerCommand(
    'smartReferences.openPinnedReferenceResults',
    async () => {
      const removeButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('trash'),
        tooltip: 'Remove pinned result',
      };
      const editNoteButton: vscode.QuickInputButton = {
        iconPath: new vscode.ThemeIcon('edit'),
        tooltip: 'Edit note',
      };
      const buildItems = (): (vscode.QuickPickItem & { entry: PinnedReferenceResult })[] =>
        treeProvider.getPinnedResults().map(entry => ({
          label: entry.symbolName || '(anonymous symbol)',
          description: `${entry.refs.length} usages`,
          detail: [
            `${new Date(entry.pinnedAt).toLocaleString()} · ${entry.scopeFilter} · ${entry.groupingMode}`,
            entry.note ? `📝 ${entry.note}` : undefined,
          ].filter(Boolean).join('  '),
          buttons: [editNoteButton, removeButton],
          entry,
        }));

      if (buildItems().length === 0) {
        vscode.window.showInformationMessage('No pinned reference results');
        return;
      }

      const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem & { entry: PinnedReferenceResult }>();
      quickPick.title = 'Pinned Reference Results';
      quickPick.placeholder = 'Select a pinned result to reopen';
      quickPick.matchOnDescription = true;
      quickPick.matchOnDetail = true;
      quickPick.items = buildItems();

      quickPick.onDidTriggerItemButton(async e => {
        if (e.button === editNoteButton) {
          quickPick.hide();
          const current = e.item.entry.note ?? '';
          const note = await vscode.window.showInputBox({
            prompt: `Note for "${e.item.entry.symbolName}"`,
            value: current,
            placeHolder: 'Add a note (leave empty to clear)',
          });
          if (note !== undefined) {
            treeProvider.setPinnedNote(e.item.entry.id, note);
          }
          // Reopen the quickpick with updated items
          void vscode.commands.executeCommand('smartReferences.openPinnedReferenceResults');
          return;
        }
        treeProvider.removePinnedResult(e.item.entry.id);
        quickPick.items = buildItems();
        if (quickPick.items.length === 0) {
          quickPick.hide();
          vscode.window.showInformationMessage('No pinned reference results');
        }
      });
      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (!selected) return;
        if (treeProvider.openPinnedResult(selected.entry.id)) {
          refreshReferenceTitle();
          updateRefHistoryContext();
          scheduleRevealActiveReference();
          void vscode.commands.executeCommand('smartReferencesTree.focus');
        }
        quickPick.hide();
      });
      quickPick.onDidHide(() => quickPick.dispose());
      quickPick.show();
    },
  );

  // Context menu commands for Project Explorer
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  function extractUri(item: any): vscode.Uri | undefined {
    if (!item) return undefined;
    const raw = item.resourceUri;
    if (!raw) {
      const fsPath = item.dirPath
        ? path.join(wsRoot, item.dirPath)
        : item.relativePath ? path.join(wsRoot, item.relativePath) : undefined;
      return fsPath ? vscode.Uri.file(fsPath) : undefined;
    }
    if (raw instanceof vscode.Uri) return resolveRealUri(item);
    if (raw.scheme && raw.path) {
      return raw.scheme === PROJ_TEST_SCHEME
        ? vscode.Uri.file(raw.path)
        : vscode.Uri.from({ scheme: raw.scheme, path: raw.path });
    }
    return undefined;
  }

  const revealInOSCmd = vscode.commands.registerCommand(
    'smartReferences.revealInOS',
    (item: any) => { const uri = extractUri(item); if (uri) vscode.commands.executeCommand('revealFileInOS', uri); },
  );
  const openTerminalCmd = vscode.commands.registerCommand(
    'smartReferences.openTerminalHere',
    (item: any) => { const uri = extractUri(item); if (uri) vscode.commands.executeCommand('openInIntegratedTerminal', uri); },
  );
  const openToSideCmd = vscode.commands.registerCommand(
    'smartReferences.openToSide',
    (item: any) => { const uri = extractUri(item); if (uri) vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside }); },
  );
  const findInFolderCmd = vscode.commands.registerCommand(
    'smartReferences.findInFolder',
    (item: any) => {
      const uri = extractUri(item);
      if (uri) vscode.commands.executeCommand('workbench.action.findInFiles', { filesToInclude: vscode.workspace.asRelativePath(uri) + '/**' });
    },
  );
  const newFileCmd = vscode.commands.registerCommand(
    'smartReferences.newFile',
    async (item: any) => {
      const uri = extractUri(item);
      if (!uri) return;
      const name = await vscode.window.showInputBox({ prompt: 'New file name', validateInput: v => v && !/[/\\]/.test(v) ? null : 'Invalid name' });
      if (!name) return;
      const target = vscode.Uri.file(path.join(uri.fsPath, name));
      await vscode.workspace.fs.writeFile(target, new Uint8Array());
      projectExplorer.scheduleRefresh();
      await vscode.window.showTextDocument(target);
    },
  );
  const newFolderCmd = vscode.commands.registerCommand(
    'smartReferences.newFolder',
    async (item: any) => {
      const uri = extractUri(item);
      if (!uri) return;
      const name = await vscode.window.showInputBox({ prompt: 'New folder name', validateInput: v => v && !/[/\\]/.test(v) ? null : 'Invalid name' });
      if (!name) return;
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(uri.fsPath, name)));
      projectExplorer.scheduleRefresh();
    },
  );
  const renameFileCmd = vscode.commands.registerCommand(
    'smartReferences.renameFile',
    async (item: any) => {
      const uri = extractUri(item);
      if (!uri) return;
      const oldName = path.basename(uri.fsPath);
      const newName = await vscode.window.showInputBox({ prompt: 'New name', value: oldName });
      if (!newName || newName === oldName) return;
      await vscode.workspace.fs.rename(uri, vscode.Uri.file(path.join(path.dirname(uri.fsPath), newName)));
      projectExplorer.scheduleRefresh();
    },
  );
  const deleteFileCmd = vscode.commands.registerCommand(
    'smartReferences.deleteFile',
    async (item: any) => {
      const uri = extractUri(item);
      if (!uri) return;
      const name = path.basename(uri.fsPath);
      const choice = await vscode.window.showWarningMessage(
        `Delete "${name}"? This cannot be undone.`, { modal: true }, 'Delete',
      );
      if (choice === 'Delete') {
        try {
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
        } catch {
          await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
        }
        projectExplorer.scheduleRefresh();
      }
    },
  );
  const copyPathCmd = vscode.commands.registerCommand(
    'smartReferences.copyPath',
    (item: any) => { const uri = extractUri(item); if (uri) vscode.env.clipboard.writeText(uri.fsPath); },
  );
  const copyRelPathCmd = vscode.commands.registerCommand(
    'smartReferences.copyRelativePath',
    (item: any) => {
      const uri = extractUri(item);
      if (uri && wsRoot) vscode.env.clipboard.writeText(path.relative(wsRoot, uri.fsPath));
    },
  );

  // Translation (Alt+A)
  const translationMgr = new TranslationManager(outputChannel);
  const translationDocProvider = vscode.workspace.registerTextDocumentContentProvider(
    'translation-view',
    translationMgr,
  );
  const translationHoverProvider = vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    translationMgr,
  );
  const translateCmd = vscode.commands.registerCommand(
    'smartReferences.translate',
    () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('No active editor for translation.');
        return;
      }
      translationMgr.executeTranslate(editor);
    },
  );

  // Reload test patterns when config changes
  const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('smartReferences')) {
      testDetector.reload();
      lensProvider.refresh();
      projectExplorer.scheduleRefresh();
    }
    if (e.affectsConfiguration('smartReferences.textSearch.historySize')) {
      void refreshTextSearchHistoryFromConfig();
    }
    if (!textSearchProvider.getQuery()) {
      textSearchDraftRequest = textSearchProvider.getEditableRequest();
    }
    if (textSearchProvider.getQuery() && (
      e.affectsConfiguration('smartReferences.textSearch')
      || e.affectsConfiguration('search.exclude')
      || e.affectsConfiguration('files.exclude')
      || e.affectsConfiguration('search.useIgnoreFiles')
      || e.affectsConfiguration('search.useGlobalIgnoreFiles')
      || e.affectsConfiguration('search.useParentIgnoreFiles')
      || e.affectsConfiguration('search.followSymlinks')
      || e.affectsConfiguration('search.smartCase')
    )) {
      void refreshTextSearchResults(false);
    }
  });

  context.subscriptions.push(
    cache,
    previewer,
    treeProvider,
    hierarchyProvider,
    structureProvider,
    structureView,
    treeVisibilityListener,
    projectExplorerVisibilityListener,
    projectExplorerStateListener,
    structureVisibilityListener,
    editorChangeListener,
    docChangeListener,
    selectionChangeListener,
    refreshStructureCmd,
    showStructureCmd,
    decorationProvider,
    treeView,
    hierarchyView,
    textSearchProvider,
    textSearchView,
    depTreeView,
    depVisibilityListener,
    depProvider,
    compositeDepIndexer,
    ...depWatchers,
    metaFileDecor,
    csharpUsingLinkProvider,
    csharpLinks,
    csharpWsTypeIndexer,
    csharpDefinitionProvider,
    csharpDefRegistration,
    protoSymbolNavigationProvider,
    protoDefinitions,
    protoReferences,
    protoImplementations,
    csharpProjLinkProvider,
    csharpProjLinks,
    csFileWatcher,
    pythonImportLinkProvider,
    pythonLinks,
    lensRegistration,
    implHints,
    findCmd,
    previewCmd,
    findAtCmd,
    hierarchyCmd,
    goToImplCmd,
    prevRefCmd,
    nextRefCmd,
    prevImplCmd,
    nextImplCmd,
    outputChannel,
    goModLinkProvider,
    goModLinks,
    symbolSearch,
    searchAllCmd,
    searchFunctionCmd,
    searchTypeCmd,
    searchTextCmd,
    searchTextFromSelectionCmd,
    editTextSearchCmd,
    previousTextSearchHistoryCmd,
    nextTextSearchHistoryCmd,
    refreshTextSearchCmd,
    configureTextSearchCmd,
    toggleTextSearchMatchCaseCmd,
    toggleTextSearchWholeWordCmd,
    toggleTextSearchRegexCmd,
    setTextSearchIncludeCmd,
    setTextSearchExcludeCmd,
    toggleTextSearchFuzzyCmd,
    setTextSearchGroupingCmd,
    replaceAllTextSearchResultsCmd,
    undoLastTextSearchReplaceCmd,
    replaceTextSearchMatchCmd,
    replaceTextSearchSectionCmd,
    replaceTextSearchFileCmd,
    refreshDepsCmd,
    searchDepsCmd,
    searchDepSymbolsCmd,
    projectExplorer,
    projectExplorerView,
    projTestDecoration,
    nativeTestDecor,
    refreshProjectCmd,
    toggleProjectViewCmd,
    setReferenceScopeCmd,
    setReferenceGroupingCmd,
    exportReferenceResultsCmd,
    filterReferenceKeywordCmd,
    pinReferenceResultsCmd,
    openPinnedReferenceResultsCmd,
    revealInOSCmd,
    openTerminalCmd,
    openToSideCmd,
    findInFolderCmd,
    newFileCmd,
    newFolderCmd,
    renameFileCmd,
    deleteFileCmd,
    copyPathCmd,
    copyRelPathCmd,
    gitignoreWatcher,
    fileCreateListener,
    fileDeleteListener,
    configWatcher,
    translationMgr,
    translationDocProvider,
    translationHoverProvider,
    translateCmd,
    new vscode.Disposable(() => {
      if (refRevealTimer) clearTimeout(refRevealTimer);
    }),
  );

  return {
    async refreshProjectExplorer(force = true) {
      await projectExplorer.refresh(force);
    },
    getProjectExplorerState() {
      return {
        currentViewMode: projectExplorer.getCurrentViewMode(),
        availableViewModes: projectExplorer.getAvailableViewModes(),
      };
    },
    async setProjectExplorerViewMode(mode: ProjectViewMode) {
      projectExplorer.setViewMode(mode);
    },
  };
}

export function deactivate(): void {
  // Nothing to clean up beyond subscriptions
}
