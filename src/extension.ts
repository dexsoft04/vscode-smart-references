import * as vscode from 'vscode';
import { ReferenceTreeProvider, SerializedPin } from './providers/ReferenceTreeProvider';
import { ReferenceLensProvider } from './providers/ReferenceLensProvider';
import { ReferenceClassifier } from './core/ReferenceClassifier';
import { ReferenceCache } from './core/Cache';
import { TestFileDetector } from './analyzers/TestFileDetector';
import { ReferencePreviewManager } from './providers/ReferencePreviewManager';
import { TextSearchTreeProvider } from './providers/TextSearchTreeProvider';
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
import { ProjectExplorerProvider, ProjectTestDecorationProvider } from './providers/ProjectExplorerProvider';
import { StructureTreeProvider } from './providers/StructureTreeProvider';
import { ProjectViewMode } from './providers/ProjectExplorerGrouping';
import { ImplInlayHintsProvider } from './providers/ImplInlayHintsProvider';
import { ProtoWorkspaceNavigator } from './core/ProtoWorkspaceNavigator';
import { ProtoSymbolNavigationProvider } from './providers/ProtoSymbolNavigationProvider';
import { CodePreviewViewProvider } from './providers/CodePreviewViewProvider';
import { registerReferenceCommands } from './commands/referenceCommands';
import { registerTextSearchCommands } from './commands/textSearchCommands';
import { registerProjectCommands } from './commands/projectCommands';
import { registerTranslationCommands } from './commands/translationCommands';

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
  const codePreviewProvider = new CodePreviewViewProvider(outputChannel);
  const textSearchCodePreviewProvider = new CodePreviewViewProvider(outputChannel);
  const textSearchProvider = new TextSearchTreeProvider();

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

  // Watch .cs file changes -> invalidate workspace type index
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

  // Register CodePreview webviews (sidebar + search panel)
  const codePreviewRegistration = vscode.window.registerWebviewViewProvider(
    CodePreviewViewProvider.viewType,
    codePreviewProvider,
  );
  const textSearchCodePreviewRegistration = vscode.window.registerWebviewViewProvider(
    'textSearchCodePreview',
    textSearchCodePreviewProvider,
  );

  // ── History navigation helpers ─────────────────────────────────────────
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

  // ── Register command modules ───────────────────────────────────────────
  const referenceDisposables = registerReferenceCommands({
    classifier, treeProvider, hierarchyProvider, previewer,
    codePreviewProvider, textSearchCodePreviewProvider,
    projectExplorer, protoNavigator, outputChannel,
    treeView, hierarchyView,
    refreshReferenceTitle, updateRefHistoryContext, updateImplHistoryContext,
    scheduleRevealActiveReference,
  });

  const textSearch = registerTextSearchCommands({
    context, outputChannel, textSearchProvider, symbolSearch, textSearchView,
  });

  const projectDisposables = registerProjectCommands({
    treeProvider, projectExplorer, structureProvider, depProvider, symbolSearch,
  });

  const translation = registerTranslationCommands({ outputChannel });

  // ── Editor / document event listeners ──────────────────────────────────
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

  // InlayHints: show "<- N impls" inline at end of interface/struct lines
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

  // Reload test patterns when config changes
  const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('smartReferences')) {
      testDetector.reload();
      lensProvider.refresh();
      projectExplorer.scheduleRefresh();
    }
    textSearch.onConfigChange(e);
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
    codePreviewProvider,
    codePreviewRegistration,
    textSearchCodePreviewProvider,
    textSearchCodePreviewRegistration,
    outputChannel,
    goModLinkProvider,
    goModLinks,
    symbolSearch,
    projTestDecoration,
    nativeTestDecor,
    projectExplorer,
    projectExplorerView,
    gitignoreWatcher,
    fileCreateListener,
    fileDeleteListener,
    configWatcher,
    ...referenceDisposables,
    ...textSearch.disposables,
    ...projectDisposables,
    ...translation.disposables,
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
