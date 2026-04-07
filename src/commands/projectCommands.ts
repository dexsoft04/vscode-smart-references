import * as vscode from 'vscode';
import * as path from 'path';
import { ReferenceTreeProvider } from '../providers/ReferenceTreeProvider';
import { ProjectExplorerProvider, resolveRealUri, PROJ_TEST_SCHEME } from '../providers/ProjectExplorerProvider';
import { StructureTreeProvider } from '../providers/StructureTreeProvider';
import { DependencyTreeProvider } from '../providers/DependencyTreeProvider';
import { SymbolSearchProvider } from '../providers/SymbolSearchProvider';
import { ProjectViewMode } from '../providers/ProjectExplorerGrouping';
import { t } from '../i18n';

export interface ProjectCommandsDeps {
  treeProvider: ReferenceTreeProvider;
  projectExplorer: ProjectExplorerProvider;
  structureProvider: StructureTreeProvider;
  depProvider: DependencyTreeProvider;
  symbolSearch: SymbolSearchProvider;
}

export function registerProjectCommands(deps: ProjectCommandsDeps): vscode.Disposable[] {
  const { treeProvider, projectExplorer, structureProvider, depProvider, symbolSearch } = deps;

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
      await projectExplorer.refresh(true);
      projectExplorer.setViewMode(picked.mode);
      if (picked.mode === 'hotspot') {
        projectExplorer.updateHitCounts(treeProvider.getFileHitCounts());
      }
    },
  );

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

  return [
    refreshStructureCmd,
    showStructureCmd,
    refreshDepsCmd,
    searchDepsCmd,
    searchDepSymbolsCmd,
    refreshProjectCmd,
    toggleProjectViewCmd,
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
  ];
}
