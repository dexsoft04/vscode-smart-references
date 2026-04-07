import * as vscode from 'vscode';
import { ReferenceClassifier } from '../core/ReferenceClassifier';
import { ReferenceTreeProvider, ReferenceScopeFilter, ReferenceGroupingMode, PinnedReferenceResult } from '../providers/ReferenceTreeProvider';
import { TypeHierarchyTreeProvider } from '../providers/TypeHierarchyTreeProvider';
import { ReferencePreviewManager } from '../providers/ReferencePreviewManager';
import { CodePreviewViewProvider } from '../providers/CodePreviewViewProvider';
import { ProjectExplorerProvider } from '../providers/ProjectExplorerProvider';
import { ProtoWorkspaceNavigator } from '../core/ProtoWorkspaceNavigator';

export interface ReferenceCommandsDeps {
  classifier: ReferenceClassifier;
  treeProvider: ReferenceTreeProvider;
  hierarchyProvider: TypeHierarchyTreeProvider;
  previewer: ReferencePreviewManager;
  codePreviewProvider: CodePreviewViewProvider;
  textSearchCodePreviewProvider?: CodePreviewViewProvider;
  projectExplorer: ProjectExplorerProvider;
  protoNavigator: ProtoWorkspaceNavigator;
  outputChannel: vscode.OutputChannel;
  treeView: vscode.TreeView<any>;
  hierarchyView: vscode.TreeView<any>;
  refreshReferenceTitle: () => void;
  updateRefHistoryContext: () => void;
  updateImplHistoryContext: () => void;
  scheduleRevealActiveReference: (editor?: vscode.TextEditor) => void;
}

export function registerReferenceCommands(deps: ReferenceCommandsDeps): vscode.Disposable[] {
  const {
    classifier, treeProvider, hierarchyProvider, previewer,
    codePreviewProvider, projectExplorer, protoNavigator, outputChannel,
    treeView, hierarchyView,
    refreshReferenceTitle, updateRefHistoryContext, updateImplHistoryContext,
    scheduleRevealActiveReference,
  } = deps;

  async function runFind(uri: vscode.Uri, position: vscode.Position): Promise<void> {
    treeProvider.setScopeAnchor(uri);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'IntelliJ-Style Dev: analyzing...',
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
          vscode.window.showErrorMessage(`IntelliJ-Style Dev error: ${String(err)}`);
        }
      },
    );
  }

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

  let lastPreviewClick: { uri: string; line: number; time: number } | undefined;
  const previewCmd = vscode.commands.registerCommand(
    'smartReferences.previewReference',
    async (uri: vscode.Uri, range: vscode.Range) => {
      const now = Date.now();
      const key = uri.toString();
      const line = range.start.line;
      const isDoubleClick = lastPreviewClick
        && lastPreviewClick.uri === key
        && lastPreviewClick.line === line
        && (now - lastPreviewClick.time) < 300;
      lastPreviewClick = { uri: key, line, time: now };

      if (isDoubleClick) {
        await previewer.preview(uri, range);
      } else {
        await codePreviewProvider.updatePreview(uri, range);
      }
    },
  );

  const previewTextSearchCmd = vscode.commands.registerCommand(
    'smartReferences.previewTextSearchReference',
    async (uri: vscode.Uri, range: vscode.Range) => {
      if (deps.textSearchCodePreviewProvider) {
        await deps.textSearchCodePreviewProvider.updatePreview(uri, range);
      }
    },
  );

  const findAtCmd = vscode.commands.registerCommand(
    'smartReferences.findReferencesAt',
    async (uri: vscode.Uri, pos: vscode.Position) => {
      await runFind(uri, pos);
    },
  );

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
        placeHolder: 'e.g. error userId  (space = AND)  or  /regex/',
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

  return [
    findCmd,
    previewCmd,
    previewTextSearchCmd,
    findAtCmd,
    hierarchyCmd,
    goToImplCmd,
    prevRefCmd,
    nextRefCmd,
    prevImplCmd,
    nextImplCmd,
    setReferenceScopeCmd,
    setReferenceGroupingCmd,
    exportReferenceResultsCmd,
    filterReferenceKeywordCmd,
    pinReferenceResultsCmd,
    openPinnedReferenceResultsCmd,
  ];
}
