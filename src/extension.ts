import * as vscode from 'vscode';
import * as path from 'path';
import { ReferenceTreeProvider, ReferenceScopeFilter, ReferenceGroupingMode, PinnedReferenceResult } from './providers/ReferenceTreeProvider';
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
  treeProvider.setScopeAnchor(vscode.window.activeTextEditor?.document.uri);
  const lensProvider = new ReferenceLensProvider(testDetector);
  const previewer = new ReferencePreviewManager();
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
    readonly originalLineOffsets: number[];
    currentLineOffsets: number[];
    workingText: string;
    applied: Array<{ originalStart: number; delta: number }>;
  }

  const focusTextSearchView = async (): Promise<void> => {
    await vscode.commands.executeCommand('textSearchTree.focus');
  };

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
    try {
      const applied = await textSearchProvider.search(request);
      if (applied) {
        textSearchDraftRequest = { ...request };
        showTextSearchWarning();
      }
      return applied;
    } catch (err) {
      if (isTextSearchCancelled(err)) return false;
      const message = String(err);
      if (message.includes('ENOENT')) {
        vscode.window.showErrorMessage('搜索增强需要系统 PATH 中可用的 ripgrep (`rg`)。');
      } else {
        vscode.window.showErrorMessage(`搜索增强错误: ${message}`);
      }
      return false;
    }
  };

  const refreshTextSearchResults = async (showWarning = true): Promise<void> => {
    try {
      const applied = await textSearchProvider.refresh();
      if (applied) {
        textSearchDraftRequest = textSearchProvider.getEditableRequest();
        if (showWarning) showTextSearchWarning();
      }
    } catch (err) {
      if (isTextSearchCancelled(err)) return;
      const message = String(err);
      if (message.includes('ENOENT')) {
        vscode.window.showErrorMessage('搜索增强需要系统 PATH 中可用的 ripgrep (`rg`)。');
      } else {
        vscode.window.showErrorMessage(`搜索增强错误: ${message}`);
      }
    }
  };

  const promptReplaceText = async (initialValue: string): Promise<string | undefined> => {
    return await vscode.window.showInputBox({
      prompt: '替换为',
      value: initialValue,
      ignoreFocusOut: true,
    });
  };

  const getCurrentTextSearchQuery = (): string => (textSearchProvider.getSearchRequest()?.query ?? textSearchDraftRequest.query).trim();
  const getTextSearchGroupingLabel = (mode: TextSearchGroupingMode = textSearchProvider.getGroupingMode()): string => (
    mode === 'none'
      ? '无分组'
      : mode === 'content'
        ? '代码 / 注释'
        : mode === 'fileKind'
          ? '代码 / 配置文件'
          : '组合分组'
  );

  const applyTextSearchDraft = async (
    nextDraft: TextSearchRequest,
    successMessage?: string,
    queryOverride?: string,
  ): Promise<boolean> => {
    textSearchDraftRequest = nextDraft;
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
      prompt: '包含文件 Glob，留空表示不限制',
      value: textSearchDraftRequest.include,
      ignoreFocusOut: true,
    });
    if (include === undefined) return false;
    const value = include.trim();
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, include: value },
      value ? `搜索增强已设置包含文件: ${value}` : '搜索增强已清除包含文件限制。',
      queryOverride,
    );
  };

  const setTextSearchExclude = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const exclude = await vscode.window.showInputBox({
      prompt: '排除文件 Glob，留空表示不额外排除',
      value: textSearchDraftRequest.exclude,
      ignoreFocusOut: true,
    });
    if (exclude === undefined) return false;
    const value = exclude.trim();
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, exclude: value },
      value ? `搜索增强已设置排除文件: ${value}` : '搜索增强已清除额外排除规则。',
      queryOverride,
    );
  };

  const toggleTextSearchMatchCase = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const before = textSearchDraftRequest.matchCase;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, matchCase: !textSearchDraftRequest.matchCase },
      before ? '搜索增强已关闭区分大小写。' : '搜索增强已开启区分大小写。',
      queryOverride,
    );
  };

  const toggleTextSearchWholeWord = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    if (textSearchDraftRequest.fuzzySearch) {
      void vscode.window.showWarningMessage('模糊搜索不支持整词匹配，请先关闭模糊搜索。');
      return false;
    }
    const before = textSearchDraftRequest.matchWholeWord;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, matchWholeWord: !textSearchDraftRequest.matchWholeWord },
      before ? '搜索增强已关闭整词匹配。' : '搜索增强已开启整词匹配。',
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
      before ? '搜索增强已关闭正则搜索。' : '搜索增强已开启正则搜索。',
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
      before ? '搜索增强已关闭模糊搜索。' : '搜索增强已开启模糊搜索。',
      queryOverride,
    );
  };

  const setTextSearchBeforeContext = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const beforeContext = await vscode.window.showInputBox({
      prompt: '上文行数',
      value: String(textSearchDraftRequest.beforeContextLines),
      ignoreFocusOut: true,
      validateInput: value => /^\d+$/.test(value) && Number(value) <= 20 ? null : '请输入 0-20 之间的整数',
    });
    if (beforeContext === undefined) return false;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, beforeContextLines: Number(beforeContext) },
      `搜索增强已设置上文行数: ${beforeContext}`,
      queryOverride,
    );
  };

  const setTextSearchAfterContext = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const afterContext = await vscode.window.showInputBox({
      prompt: '下文行数',
      value: String(textSearchDraftRequest.afterContextLines),
      ignoreFocusOut: true,
      validateInput: value => /^\d+$/.test(value) && Number(value) <= 20 ? null : '请输入 0-20 之间的整数',
    });
    if (afterContext === undefined) return false;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, afterContextLines: Number(afterContext) },
      `搜索增强已设置下文行数: ${afterContext}`,
      queryOverride,
    );
  };

  const setTextSearchGrouping = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const items: Array<{ label: string; description: string; mode: TextSearchGroupingMode }> = [
      { label: '无分组', description: '按文件直接显示', mode: 'none' },
      { label: '代码 / 注释', description: '区分代码和注释命中', mode: 'content' },
      { label: '代码 / 配置文件', description: '区分代码文件和配置文件', mode: 'fileKind' },
      { label: '组合分组', description: '同时按内容和文件类型分组', mode: 'both' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: '选择搜索结果分组方式',
      ignoreFocusOut: true,
    });
    if (!pick) return false;
    textSearchProvider.setGroupingMode(pick.mode);
    const nextQuery = queryOverride !== undefined ? queryOverride.trim() : getCurrentTextSearchQuery();
    if (nextQuery) {
      return await runTextSearch({ ...textSearchDraftRequest, query: nextQuery });
    }
    void vscode.window.showInformationMessage(`搜索增强已切换分组: ${getTextSearchGroupingLabel(pick.mode)}`);
    return true;
  };

  const configureTextSearch = async (queryOverride?: string): Promise<boolean> => {
    const items = [
      { label: '包含文件', description: textSearchDraftRequest.include || '未设置', action: 'include' as const },
      { label: '排除文件', description: textSearchDraftRequest.exclude || '未设置', action: 'exclude' as const },
      { label: '区分大小写', description: textSearchDraftRequest.matchCase ? '已开启' : '已关闭', action: 'matchCase' as const },
      { label: '整词匹配', description: textSearchDraftRequest.matchWholeWord ? '已开启' : '已关闭', action: 'wholeWord' as const },
      { label: '正则搜索', description: textSearchDraftRequest.useRegExp ? '已开启' : '已关闭', action: 'regex' as const },
      { label: '模糊搜索', description: textSearchDraftRequest.fuzzySearch ? '已开启' : '已关闭', action: 'fuzzy' as const },
      { label: '上文行数', description: String(textSearchDraftRequest.beforeContextLines), action: 'before' as const },
      { label: '下文行数', description: String(textSearchDraftRequest.afterContextLines), action: 'after' as const },
      { label: '结果分组', description: getTextSearchGroupingLabel(), action: 'grouping' as const },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要调整的一项搜索设置',
      ignoreFocusOut: true,
    });
    if (!pick) return false;
    if (pick.action === 'include') return await setTextSearchInclude(queryOverride);
    if (pick.action === 'exclude') return await setTextSearchExclude(queryOverride);
    if (pick.action === 'matchCase') return await toggleTextSearchMatchCase(queryOverride);
    if (pick.action === 'wholeWord') return await toggleTextSearchWholeWord(queryOverride);
    if (pick.action === 'regex') return await toggleTextSearchRegex(queryOverride);
    if (pick.action === 'fuzzy') return await toggleTextSearchFuzzy(queryOverride);
    if (pick.action === 'before') return await setTextSearchBeforeContext(queryOverride);
    if (pick.action === 'after') return await setTextSearchAfterContext(queryOverride);
    return await setTextSearchGrouping(queryOverride);
  };

  const promptTextSearchQuery = async (initialValue: string): Promise<{ kind: string; query: string } | undefined> => {
    const input = vscode.window.createInputBox();
    input.title = '搜索增强';
    input.prompt = '搜索内容';
    input.placeholder = '输入要搜索的文本';
    input.value = initialValue;
    input.ignoreFocusOut = true;

    const buttons = {
      include: { iconPath: new vscode.ThemeIcon('filter'), tooltip: `包含文件: ${textSearchDraftRequest.include || '未设置'}` },
      exclude: { iconPath: new vscode.ThemeIcon('close'), tooltip: `排除文件: ${textSearchDraftRequest.exclude || '未设置'}` },
      matchCase: { iconPath: new vscode.ThemeIcon('case-sensitive'), tooltip: `区分大小写: ${textSearchDraftRequest.matchCase ? '开' : '关'}` },
      wholeWord: { iconPath: new vscode.ThemeIcon('whole-word'), tooltip: `整词匹配: ${textSearchDraftRequest.matchWholeWord ? '开' : '关'}` },
      regex: { iconPath: new vscode.ThemeIcon('regex'), tooltip: `正则搜索: ${textSearchDraftRequest.useRegExp ? '开' : '关'}` },
      fuzzy: { iconPath: new vscode.ThemeIcon('symbol-string'), tooltip: `模糊搜索: ${textSearchDraftRequest.fuzzySearch ? '开' : '关'}` },
      beforeContext: { iconPath: new vscode.ThemeIcon('arrow-up'), tooltip: `上文行数: ${textSearchDraftRequest.beforeContextLines}` },
      afterContext: { iconPath: new vscode.ThemeIcon('arrow-down'), tooltip: `下文行数: ${textSearchDraftRequest.afterContextLines}` },
      grouping: { iconPath: new vscode.ThemeIcon('list-tree'), tooltip: `结果分组: ${getTextSearchGroupingLabel()}` },
    } as const;
    input.buttons = [
      buttons.include,
      buttons.exclude,
      buttons.matchCase,
      buttons.wholeWord,
      buttons.regex,
      buttons.fuzzy,
      buttons.beforeContext,
      buttons.afterContext,
      buttons.grouping,
    ];

    return await new Promise(resolve => {
      let settled = false;
      const finish = (result: { kind: string; query: string } | undefined) => {
        if (settled) return;
        settled = true;
        disposables.forEach(disposable => disposable.dispose());
        input.hide();
        resolve(result);
      };
      const disposables: vscode.Disposable[] = [
        input.onDidAccept(() => finish({ kind: 'submit', query: input.value })),
        input.onDidTriggerButton(button => {
          const query = input.value;
          if (button === buttons.include) finish({ kind: 'include', query });
          else if (button === buttons.exclude) finish({ kind: 'exclude', query });
          else if (button === buttons.matchCase) finish({ kind: 'matchCase', query });
          else if (button === buttons.wholeWord) finish({ kind: 'wholeWord', query });
          else if (button === buttons.regex) finish({ kind: 'regex', query });
          else if (button === buttons.fuzzy) finish({ kind: 'fuzzy', query });
          else if (button === buttons.beforeContext) finish({ kind: 'beforeContext', query });
          else if (button === buttons.afterContext) finish({ kind: 'afterContext', query });
          else if (button === buttons.grouping) finish({ kind: 'grouping', query });
        }),
        input.onDidHide(() => finish(undefined)),
      ];
      input.show();
    });
  };

  const executeTextSearchReplace = async (
    request: TextSearchRequest,
    targets: TextSearchReplaceTarget[],
    mode: 'single' | 'all',
  ): Promise<void> => {
    if (targets.length === 0) return;
    if (request.fuzzySearch) {
      void vscode.window.showWarningMessage('模糊搜索结果不支持替换。');
      return;
    }

    const fileContexts = new Map<string, ReplacementFileContext>();
    const startedAt = new Date().toISOString();
    let completed = 0;
    outputChannel.appendLine(`[text-search:replace] start ${startedAt} mode=${mode} files=${new Set(targets.map(target => target.uri)).size} matches=${targets.length}`);
    outputChannel.appendLine(`[text-search:replace] query=${JSON.stringify(request.query)} regex=${request.useRegExp} case=${request.matchCase} word=${request.matchWholeWord}`);

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
          outputChannel.appendLine(`[text-search:replace] fail ${target.relativePath}:${target.lineNumber} ${message}`);
          throw new Error(`替换已在 ${target.relativePath}:${target.lineNumber} 停止: ${message}`);
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
          outputChannel.appendLine(`[text-search:replace] fail ${target.relativePath}:${target.lineNumber} ${message}`);
          throw new Error(`替换已在 ${target.relativePath}:${target.lineNumber} 停止: ${message}`);
        }

        contextForFile.workingText = `${contextForFile.workingText.slice(0, adjustedStart)}${replacementText}${contextForFile.workingText.slice(adjustedEnd)}`;
        contextForFile.currentLineOffsets = buildLineOffsets(contextForFile.workingText);
        contextForFile.applied.push({ originalStart, delta: replacementText.length - currentSlice.length });
        completed += 1;
        outputChannel.appendLine(
          `[text-search:replace] ok ${target.relativePath}:${target.lineNumber} match=${JSON.stringify(formatLogValue(currentSlice))} replace=${JSON.stringify(formatLogValue(replacementText))}`,
        );
      }
      outputChannel.appendLine(`[text-search:replace] done mode=${mode} completed=${completed}/${targets.length}`);
      textSearchDraftRequest = { ...request };
      await refreshTextSearchResults(false);
      void vscode.window.showInformationMessage(mode === 'single' ? '已替换 1 处命中' : `已顺序替换 ${completed} 处命中`);
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      outputChannel.appendLine(`[text-search:replace] stopped completed=${completed}/${targets.length} reason=${message}`);
      await refreshTextSearchResults(false);
      void vscode.window.showErrorMessage(message);
    }
  };

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
      let seedQuery = selectedText || textSearchProvider.getSearchRequest()?.query || textSearchDraftRequest.query;
      while (true) {
        const result = await promptTextSearchQuery(seedQuery);
        if (!result) return;
        seedQuery = result.query;
        if (result.kind === 'include') {
          await setTextSearchInclude(seedQuery);
          continue;
        }
        if (result.kind === 'exclude') {
          await setTextSearchExclude(seedQuery);
          continue;
        }
        if (result.kind === 'matchCase') {
          await toggleTextSearchMatchCase(seedQuery);
          continue;
        }
        if (result.kind === 'wholeWord') {
          await toggleTextSearchWholeWord(seedQuery);
          continue;
        }
        if (result.kind === 'regex') {
          await toggleTextSearchRegex(seedQuery);
          continue;
        }
        if (result.kind === 'fuzzy') {
          await toggleTextSearchFuzzy(seedQuery);
          continue;
        }
        if (result.kind === 'beforeContext') {
          await setTextSearchBeforeContext(seedQuery);
          continue;
        }
        if (result.kind === 'afterContext') {
          await setTextSearchAfterContext(seedQuery);
          continue;
        }
        if (result.kind === 'grouping') {
          await setTextSearchGrouping(seedQuery);
          continue;
        }
        const query = result.query;
        const request = { ...textSearchDraftRequest, query };
        if (!query.trim()) {
          textSearchProvider.clear();
          textSearchDraftRequest = { ...request, query: '' };
          await focusTextSearchView();
          return;
        }
        await runTextSearch(request);
        return;
      }
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

  const setTextSearchBeforeContextCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchBeforeContext',
    async () => {
      await setTextSearchBeforeContext();
    },
  );

  const setTextSearchAfterContextCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchAfterContext',
    async () => {
      await setTextSearchAfterContext();
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
        vscode.window.showInformationMessage('当前没有可替换的搜索结果。');
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const fileCount = new Set(targets.map(target => target.uri)).size;
      const answer = await vscode.window.showWarningMessage(
        `按当前显示顺序替换 ${targets.length} 处命中，涉及 ${fileCount} 个文件？`,
        { modal: true, detail: '替换会逐条执行，遇到第一处失败立即停止。' },
        '全部替换',
      );
      if (answer !== '全部替换') return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );
  const replaceTextSearchMatchCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchMatch',
    async (item?: any) => {
      const uri = item?.match?.uri?.toString?.() ?? item?.match?.uri?.toString?.call?.(item.match.uri);
      const range = item?.match?.range;
      if (!uri || !range) {
        vscode.window.showInformationMessage('请选择一条搜索命中再执行替换。');
        return;
      }
      const key = `${uri}#${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
      const targets = textSearchProvider.getOrderedReplaceTargets({ targetKey: key });
      if (targets.length === 0) {
        vscode.window.showInformationMessage('当前命中已失效，请先刷新搜索结果。');
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      await executeTextSearchReplace(request, targets, 'single');
    },
  );
  const replaceTextSearchSectionCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchSection',
    async (item?: any) => {
      const sectionKey = item?.bucket?.key;
      const sectionLabel = item?.bucket?.label ?? '当前分组';
      if (!sectionKey) {
        vscode.window.showInformationMessage('请选择一个搜索分组再执行替换。');
        return;
      }
      const targets = textSearchProvider.getOrderedReplaceTargets({ sectionKey });
      if (targets.length === 0) {
        vscode.window.showInformationMessage('当前分组没有可替换的搜索结果。');
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const fileCount = new Set(targets.map(target => target.uri)).size;
      const answer = await vscode.window.showWarningMessage(
        `按当前显示顺序替换分组“${sectionLabel}”中的 ${targets.length} 处命中，涉及 ${fileCount} 个文件？`,
        { modal: true, detail: '替换会逐条执行，遇到第一处失败立即停止。' },
        '替换当前分组',
      );
      if (answer !== '替换当前分组') return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );
  const replaceTextSearchFileCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchFile',
    async (item?: any) => {
      const fileUri = item?.bucket?.uri?.toString?.() ?? item?.bucket?.uri?.toString?.call?.(item.bucket.uri);
      const relativePath = item?.bucket?.relativePath ?? '当前文件';
      if (!fileUri) {
        vscode.window.showInformationMessage('请选择一个搜索文件节点再执行替换。');
        return;
      }
      const targets = textSearchProvider.getOrderedReplaceTargets({ fileUri });
      if (targets.length === 0) {
        vscode.window.showInformationMessage('当前文件没有可替换的搜索结果。');
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const answer = await vscode.window.showWarningMessage(
        `按当前显示顺序替换文件“${relativePath}”中的 ${targets.length} 处命中？`,
        { modal: true, detail: '替换会逐条执行，遇到第一处失败立即停止。' },
        '替换当前文件',
      );
      if (answer !== '替换当前文件') return;
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
      projectExplorer.toggleViewMode();
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
    refreshTextSearchCmd,
    configureTextSearchCmd,
    toggleTextSearchMatchCaseCmd,
    toggleTextSearchWholeWordCmd,
    toggleTextSearchRegexCmd,
    setTextSearchIncludeCmd,
    setTextSearchExcludeCmd,
    toggleTextSearchFuzzyCmd,
    setTextSearchBeforeContextCmd,
    setTextSearchAfterContextCmd,
    setTextSearchGroupingCmd,
    replaceAllTextSearchResultsCmd,
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
