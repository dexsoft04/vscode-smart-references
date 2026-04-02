import * as vscode from 'vscode';
import * as path from 'path';
import { ReferenceTreeProvider, ReferenceScopeFilter, ReferenceGroupingMode, PinnedReferenceResult } from './providers/ReferenceTreeProvider';
import { ReferenceLensProvider } from './providers/ReferenceLensProvider';
import { ReferenceClassifier } from './core/ReferenceClassifier';
import { ReferenceCache } from './core/Cache';
import { TestFileDetector } from './analyzers/TestFileDetector';
import { ReferencePreviewManager } from './providers/ReferencePreviewManager';
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
import { ImplInlayHintsProvider } from './providers/ImplInlayHintsProvider';
import { TranslationManager } from './providers/TranslationManager';
import { ProtoWorkspaceNavigator } from './core/ProtoWorkspaceNavigator';
import { ProtoSymbolNavigationProvider } from './providers/ProtoSymbolNavigationProvider';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('IntelliJ-Style References');

  const cache = new ReferenceCache();
  const testDetector = new TestFileDetector();
  const protoNavigator = new ProtoWorkspaceNavigator(outputChannel);
  const classifier = new ReferenceClassifier(testDetector, cache, protoNavigator);
  const treeProvider = new ReferenceTreeProvider();
  treeProvider.setActiveDocument(vscode.window.activeTextEditor?.document.uri);
  const lensProvider = new ReferenceLensProvider(testDetector);
  const previewer = new ReferencePreviewManager();

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
      await projectExplorerView.reveal(target, { select: false, focus: false, expand: true });
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
  // Init context for toggle button
  vscode.commands.executeCommand('setContext', 'smartReferences.projectViewCategorized', false);
  const projTestDecoration = vscode.window.registerFileDecorationProvider(new ProjectTestDecorationProvider());
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
    treeProvider.setActiveDocument(editor?.document.uri);
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
    treeProvider.setActiveDocument(uri);
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
          treeProvider.setResults(symbolName, refs);
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

  // Symbol search commands
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

  // Dependency commands
  const refreshStructureCmd = vscode.commands.registerCommand(
    'smartReferences.refreshStructure',
    () => structureProvider.refresh(),
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
    () => depProvider.refresh(),
  );
  const searchDepsCmd = vscode.commands.registerCommand(
    'smartReferences.searchDeps',
    () => depProvider.searchAndOpen(),
  );
  const searchDepSymbolsCmd = vscode.commands.registerCommand(
    'smartReferences.searchDependencySymbols',
    () => symbolSearch.showDepSymbolSearch(),
  );

  // Project explorer commands
  const refreshProjectCmd = vscode.commands.registerCommand(
    'smartReferences.refreshProjectExplorer',
    () => projectExplorer.refresh(true),
  );
  const toggleProjectViewCmd = vscode.commands.registerCommand(
    'smartReferences.toggleProjectViewMode',
    () => projectExplorer.toggleViewMode(),
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
          { label: 'Current File', description: '仅显示当前文件中的引用', value: 'currentFile' as const },
          { label: 'Current Directory', description: '仅显示当前目录中的引用', value: 'currentDirectory' as const },
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
      const buildItems = (): (vscode.QuickPickItem & { entry: PinnedReferenceResult })[] =>
        treeProvider.getPinnedResults().map(entry => ({
          label: entry.symbolName || '(anonymous symbol)',
          description: `${entry.refs.length} usages`,
          detail: `${new Date(entry.pinnedAt).toLocaleString()} · ${entry.scopeFilter} · ${entry.groupingMode}`,
          buttons: [removeButton],
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

      quickPick.onDidTriggerItemButton(e => {
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
    structureVisibilityListener,
    editorChangeListener,
    docChangeListener,
    selectionChangeListener,
    refreshStructureCmd,
    showStructureCmd,
    decorationProvider,
    treeView,
    hierarchyView,
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
}

export function deactivate(): void {
  // Nothing to clean up beyond subscriptions
}
