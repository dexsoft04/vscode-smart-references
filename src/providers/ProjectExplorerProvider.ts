import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { TestFileDetector } from '../analyzers/TestFileDetector';
import { t } from '../i18n';
import {
  CppProjectCategoryId,
  CPP_PROJECT_CATEGORY_IDS,
  classifyCppProjectPath,
  detectProjectRoots,
  getAvailableProjectViewModes,
  isCppProjectCategory,
  isGeneratedProjectPath,
  looksLikeCppProject,
  ProjectViewMode,
  resolveProjectRoot,
  resolveProjectViewMode,
  shouldDimMergedTestFile,
} from './ProjectExplorerGrouping';

interface DirEntry {
  subdirs: string[];
  files: string[];
}

interface IgnoredTree {
  index: Map<string, DirEntry>;
  ignoredDirs: Set<string>;
}

function buildDirIndex(files: string[]): Map<string, DirEntry> {
  const index = new Map<string, DirEntry>();
  const ensure = (dir: string) => {
    if (!index.has(dir)) index.set(dir, { subdirs: [], files: [] });
    return index.get(dir)!;
  };

  for (const file of files) {
    const parts = file.split('/');
    const fileName = parts[parts.length - 1];
    const parentDir = parts.length === 1 ? '' : parts.slice(0, -1).join('/');
    ensure(parentDir).files.push(fileName);

    for (let i = 1; i <= parts.length - 1; i++) {
      const parent = i === 1 ? '' : parts.slice(0, i - 1).join('/');
      const child = parts.slice(0, i).join('/');
      const entry = ensure(parent);
      if (!entry.subdirs.includes(child)) {
        entry.subdirs.push(child);
      }
      ensure(child);
    }
  }

  for (const entry of index.values()) {
    entry.subdirs.sort();
    entry.files.sort();
  }
  return index;
}

function buildIgnoredTree(entries: string[]): IgnoredTree {
  const index = new Map<string, DirEntry>();
  const ignoredDirs = new Set<string>();
  const ensure = (dir: string) => {
    if (!index.has(dir)) index.set(dir, { subdirs: [], files: [] });
    return index.get(dir)!;
  };
  const addSubdir = (parent: string, child: string) => {
    const entry = ensure(parent);
    if (!entry.subdirs.includes(child)) {
      entry.subdirs.push(child);
    }
    ensure(child);
  };

  for (const rawEntry of entries) {
    const clean = rawEntry.replace(/\/$/, '');
    if (!clean) continue;

    const parts = clean.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = i === 1 ? '' : parts.slice(0, i - 1).join('/');
      const child = parts.slice(0, i).join('/');
      addSubdir(parent, child);
    }

    const parentDir = parts.length === 1 ? '' : parts.slice(0, -1).join('/');
    if (rawEntry.endsWith('/')) {
      addSubdir(parentDir, clean);
      ignoredDirs.add(clean);
      continue;
    }

    ensure(parentDir).files.push(parts[parts.length - 1]);
  }

  for (const entry of index.values()) {
    entry.subdirs.sort();
    entry.files.sort();
  }

  return { index, ignoredDirs };
}

function joinProjectPath(projectRoot: string | undefined, relativePath: string): string {
  if (!projectRoot) return relativePath;
  if (!relativePath) return projectRoot;
  return `${projectRoot}/${relativePath}`;
}

function toProjectRelativePath(relativePath: string, projectRoot: string): string {
  if (!projectRoot) return relativePath;
  if (relativePath === projectRoot) return '';
  return relativePath.startsWith(`${projectRoot}/`) ? relativePath.slice(projectRoot.length + 1) : relativePath;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isSilentProjectExplorerGitError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('dubious ownership')
    || lower.includes('safe.directory')
    || lower.includes('not a git repository')
    || lower.includes('could not find repository');
}

function summarizeProjectExplorerGitError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('dubious ownership') || lower.includes('safe.directory')) {
    return 'workspace git access skipped due to ownership restrictions';
  }
  if (lower.includes('not a git repository') || lower.includes('could not find repository')) {
    return 'workspace git access skipped because the workspace is not a git repository';
  }
  return 'workspace git access skipped';
}

function toProjectExplorerStatusMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('dubious ownership') || lower.includes('safe.directory')) {
    return t('项目文件无法读取 Git 文件列表：当前仓库被 Git 标记为 ownership 不安全。', 'Project Files could not read the Git file list because Git blocked this workspace due to ownership restrictions.');
  }
  if (lower.includes('not a git repository') || lower.includes('could not find repository')) {
    return t('项目文件无法读取 Git 文件列表：当前工作区不是 Git 仓库。', 'Project Files could not read the Git file list because the current workspace is not a Git repository.');
  }
  return `${t('项目文件刷新失败', 'Project Files refresh failed')}: ${message}`;
}

export const PROJ_DIMMED_SCHEME = 'proj-dimmed';
export const PROJ_TEST_SCHEME = PROJ_DIMMED_SCHEME;

export class ProjectTestDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== PROJ_DIMMED_SCHEME) return undefined;
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}

export function resolveRealUri(item: vscode.TreeItem): vscode.Uri | undefined {
  if (!item.resourceUri) return undefined;
  if (item.resourceUri.scheme === PROJ_DIMMED_SCHEME) {
    return vscode.Uri.file(item.resourceUri.path);
  }
  return item.resourceUri;
}

type ProjectNode = ProjectGroupNode | CategoryNode | ProjDirectoryNode | ProjFileNode;
type ViewCategory = 'sources' | 'tests' | 'ignored' | 'all' | CppProjectCategoryId;
type RootCategory = Exclude<ViewCategory, 'all'>;

interface VisibleDirNodeInfo {
  readonly dirPath: string;
  readonly label: string;
  readonly parentDirPath: string;
}

class ProjectGroupNode extends vscode.TreeItem {
  constructor(
    public readonly projectRoot: string,
    label: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `pg:${projectRoot}`;
    this.iconPath = new vscode.ThemeIcon('root-folder');
    this.contextValue = 'projectGroup';
    this.tooltip = projectRoot || label;
  }
}

class CategoryNode extends vscode.TreeItem {
  constructor(
    public readonly category: RootCategory,
    label: string,
    icon: string,
    public readonly projectRoot = '',
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `cat:${projectRoot}|${category}`;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `projectCategory-${category}`;
  }
}

class ProjDirectoryNode extends vscode.TreeItem {
  constructor(
    public readonly dirPath: string,
    public readonly category: ViewCategory,
    workspaceRoot: string,
    public readonly projectRoot = '',
    label?: string,
    public readonly parentDirPath = '',
  ) {
    super(label ?? path.basename(dirPath), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `dir:${projectRoot}|${category}|${dirPath}`;
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, joinProjectPath(projectRoot, dirPath)));
    this.contextValue = 'projectDir';
    this.tooltip = joinProjectPath(projectRoot, dirPath);
  }
}

class ProjFileNode extends vscode.TreeItem {
  constructor(
    public readonly relativePath: string,
    workspaceRoot: string,
    dimmed: boolean,
    public readonly projectRoot = '',
  ) {
    super(path.basename(relativePath), vscode.TreeItemCollapsibleState.None);
    this.id = `file:${projectRoot}|${relativePath}`;
    const workspaceRelativePath = joinProjectPath(projectRoot, relativePath);
    const fullPath = path.join(workspaceRoot, workspaceRelativePath);
    const fileUri = vscode.Uri.file(fullPath);

    this.resourceUri = dimmed
      ? vscode.Uri.from({ scheme: PROJ_DIMMED_SCHEME, path: fileUri.path })
      : fileUri;

    this.command = { command: 'vscode.open', title: t('打开文件', 'Open File'), arguments: [fileUri] };
    this.contextValue = 'projectFile';
    this.tooltip = workspaceRelativePath;
  }
}

export class ProjectExplorerProvider implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProjectNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sourceIndex = new Map<string, DirEntry>();
  private testIndex = new Map<string, DirEntry>();
  private allIndex = new Map<string, DirEntry>();
  private cppCategoryIndexes = new Map<CppProjectCategoryId, Map<string, DirEntry>>();
  private projectCategoryIndexes = new Map<string, Map<CppProjectCategoryId, Map<string, DirEntry>>>();
  private projectRoots: string[] = [];
  private fileProjectRoots = new Map<string, string>();
  private showProjectGroups = false;
  private ignoredIndex = new Map<string, DirEntry>();
  private ignoredDirs = new Set<string>();
  private ignoredEntrySet = new Set<string>();
  private testFileSet = new Set<string>();
  private ignoredEntries: string[] = [];
  private hasSource = false;
  private hasTest = false;
  private cppProjectDetected = false;
  private viewMode: ProjectViewMode = 'merged';
  private fileHitCounts: Map<string, number> = new Map();
  private workspaceRoot: string;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshPromise: Promise<void> | null = null;
  private visible = false;
  private dirty = true;
  private lastRefreshMessage: string | undefined;

  constructor(
    private testDetector: TestFileDetector,
    private log: vscode.OutputChannel,
  ) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    this.applyViewModeContext();
  }

  getCurrentViewMode(): ProjectViewMode {
    return this.viewMode;
  }

  getAvailableViewModes(): ProjectViewMode[] {
    return getAvailableProjectViewModes(this.cppProjectDetected);
  }

  getStatusMessage(): string | undefined {
    return this.lastRefreshMessage;
  }

  updateHitCounts(counts: Map<string, number>): void {
    this.fileHitCounts = counts;
    if (this.viewMode === 'hotspot') {
      this._onDidChangeTreeData.fire();
    }
  }

  setViewMode(mode: ProjectViewMode): void {
    const nextMode = resolveProjectViewMode(mode, this.cppProjectDetected);
    if (this.viewMode === nextMode) return;
    this.viewMode = nextMode;
    this.applyViewModeContext();
    this._onDidChangeTreeData.fire();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  scheduleRefresh(force = false): void {
    this.dirty = true;
    if (!force && !this.visible) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 300);
  }

  async refresh(force = false): Promise<void> {
    if (!this.workspaceRoot) return;
    if (!force && !this.visible) {
      this.dirty = true;
      return;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.dirty = false;
    this.refreshPromise = this._doRefresh().finally(() => {
      this.refreshPromise = null;
      if (this.dirty && this.visible) {
        void this.refresh(true);
      }
    });
    return this.refreshPromise;
  }

  private async _doRefresh(): Promise<void> {
    try {
      const [trackedOutput, ignoredOutput, untrackedOutput] = await Promise.all([
        this.execGit(['ls-files']),
        this.execGit(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']),
        this.execGit(['ls-files', '--others', '--exclude-standard']),
      ]);

      const allTracked = trackedOutput.split('\n').filter(Boolean);
      const untrackedFiles = untrackedOutput.split('\n').filter(Boolean);
      const allProjectFiles = [...allTracked, ...untrackedFiles];
      this.ignoredEntries = ignoredOutput.split('\n').filter(Boolean);
      const ignoredTree = buildIgnoredTree(this.ignoredEntries);
      this.ignoredEntrySet = new Set(this.ignoredEntries.map(entry => entry.replace(/\/$/, '')));

      const sourceFiles: string[] = [];
      const testFiles: string[] = [];
      const cppBuckets = new Map<CppProjectCategoryId, string[]>(CPP_PROJECT_CATEGORY_IDS.map(category => [category, []]));
      const detectedProjectRoots = detectProjectRoots(allTracked);
      const projectBuckets = new Map<string, Map<CppProjectCategoryId, string[]>>();
      this.testFileSet = new Set();
      this.fileProjectRoots = new Map();

      const ensureProjectBucket = (projectRoot: string) => {
        if (!projectBuckets.has(projectRoot)) {
          projectBuckets.set(projectRoot, new Map(CPP_PROJECT_CATEGORY_IDS.map(category => [category, []])));
        }
        return projectBuckets.get(projectRoot)!;
      };

      for (const file of allProjectFiles) {
        const uri = vscode.Uri.file(path.join(this.workspaceRoot, file));
        const isTest = this.testDetector.isTestFile(uri);
        if (isTest) {
          testFiles.push(file);
          this.testFileSet.add(file);
        } else {
          sourceFiles.push(file);
        }

        const cppCategory = classifyCppProjectPath(file, isTest);
        cppBuckets.get(cppCategory)?.push(file);

        const projectRoot = resolveProjectRoot(file, detectedProjectRoots);
        this.fileProjectRoots.set(file, projectRoot);
        const projectRelativePath = toProjectRelativePath(file, projectRoot);
        ensureProjectBucket(projectRoot).get(cppCategory)?.push(projectRelativePath);
      }

      this.sourceIndex = buildDirIndex(sourceFiles);
      this.testIndex = buildDirIndex(testFiles);
      this.allIndex = buildDirIndex(allProjectFiles);
      this.cppCategoryIndexes = new Map(
        CPP_PROJECT_CATEGORY_IDS.map(category => [category, buildDirIndex(cppBuckets.get(category) ?? [])]),
      );
      this.projectCategoryIndexes = new Map(
        [...projectBuckets.entries()].map(([projectRoot, buckets]) => [
          projectRoot,
          new Map(CPP_PROJECT_CATEGORY_IDS.map(category => [category, buildDirIndex(buckets.get(category) ?? [])])),
        ]),
      );

      this.projectRoots = [...this.projectCategoryIndexes.keys()]
        .filter(projectRoot => CPP_PROJECT_CATEGORY_IDS.some(category => this.hasIndexContent(this.projectCategoryIndexes.get(projectRoot)?.get(category))))
        .sort((a, b) => a.localeCompare(b));
      this.showProjectGroups = this.projectRoots.length > 1;
      this.cppProjectDetected = looksLikeCppProject(allProjectFiles);
      this.ignoredIndex = ignoredTree.index;
      this.ignoredDirs = ignoredTree.ignoredDirs;
      this.hasSource = sourceFiles.length > 0;
      this.hasTest = testFiles.length > 0;
      this.viewMode = resolveProjectViewMode(this.viewMode, this.cppProjectDetected);
      this.applyViewModeContext();
      this.lastRefreshMessage = undefined;

      this.log.appendLine(
        `[project-explorer] refresh: ${sourceFiles.length} sources, ` +
        `${testFiles.length} tests, ${untrackedFiles.length} untracked, ${this.ignoredEntries.length} ignored, cpp=${this.cppProjectDetected}, projects=${this.projectRoots.length}`,
      );
    } catch (err) {
      const message = getErrorMessage(err);
      this.lastRefreshMessage = toProjectExplorerStatusMessage(message);
      if (isSilentProjectExplorerGitError(message)) {
        this.log.appendLine(`[project-explorer] refresh skipped: ${summarizeProjectExplorerGitError(message)}`);
      } else {
        this.log.appendLine(`[project-explorer] refresh error: ${message}`);
      }
      this.sourceIndex = new Map();
      this.testIndex = new Map();
      this.allIndex = new Map();
      this.cppCategoryIndexes = new Map();
      this.projectCategoryIndexes = new Map();
      this.projectRoots = [];
      this.fileProjectRoots = new Map();
      this.showProjectGroups = false;
      this.ignoredIndex = new Map();
      this.ignoredDirs = new Set();
      this.ignoredEntrySet = new Set();
      this.testFileSet = new Set();
      this.ignoredEntries = [];
      this.hasSource = false;
      this.hasTest = false;
      this.cppProjectDetected = false;
      this.viewMode = resolveProjectViewMode(this.viewMode, this.cppProjectDetected);
      this.applyViewModeContext();
    }

    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    return element;
  }

  async getParent(element: ProjectNode): Promise<ProjectNode | undefined> {
    if (element instanceof ProjectGroupNode) return undefined;

    if (element instanceof CategoryNode) {
      return this.showProjectGroups && element.projectRoot !== ''
        ? this.createProjectGroupNode(element.projectRoot)
        : undefined;
    }

    if (element instanceof ProjDirectoryNode) {
      return element.parentDirPath
        ? this.createVisibleDirectoryNode(element.parentDirPath, element.category, element.projectRoot)
        : this.getParentForPath(element.dirPath, element.category, element.projectRoot);
    }

    const workspaceRelativePath = joinProjectPath(element.projectRoot, element.relativePath);
    return this.getParentForPath(element.relativePath, this.getCategoryForPath(workspaceRelativePath), element.projectRoot);
  }

  getRevealTarget(uri: vscode.Uri): ProjectNode | undefined {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath) return undefined;
    const category = this.getCategoryForPath(relativePath);
    if (!category) return undefined;
    const projectRoot = this.showProjectGroups ? this.getProjectRootForPath(relativePath) : '';
    const projectRelativePath = this.showProjectGroups ? toProjectRelativePath(relativePath, projectRoot) : relativePath;
    const dimmed = this.shouldDimFile(relativePath, category);
    return new ProjFileNode(projectRelativePath, this.workspaceRoot, dimmed, projectRoot);
  }

  async getChildren(element?: ProjectNode): Promise<ProjectNode[]> {
    if (!element) {
      if (this.viewMode === 'hotspot') {
        if (this.fileHitCounts.size === 0) return [];
        const scored: { rel: string; count: number }[] = [];
        for (const [fsPath, count] of this.fileHitCounts) {
          const rel = this.toRelativePath(vscode.Uri.file(fsPath));
          if (rel) scored.push({ rel, count });
        }
        scored.sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
        return scored.map(({ rel, count }) => {
          const node = new ProjFileNode(rel, this.workspaceRoot, false);
          node.description = `${count} hits`;
          return node;
        });
      }

      if (this.viewMode === 'merged') {
        const nodes = this.getFromIndex(this.allIndex, '', 'all');
        if (this.ignoredEntries.length > 0) {
          nodes.push(new CategoryNode('ignored', t('已忽略', 'Ignored'), 'circle-slash'));
        }
        return nodes;
      }

      if (this.viewMode === 'cpp-project') {
        if (this.showProjectGroups) {
          const nodes: ProjectNode[] = this.projectRoots.map(projectRoot => this.createProjectGroupNode(projectRoot));
          if (this.ignoredEntries.length > 0) nodes.push(this.createCategoryNode('ignored'));
          return nodes;
        }

        const nodes: ProjectNode[] = [];
        for (const category of CPP_PROJECT_CATEGORY_IDS) {
          const index = this.cppCategoryIndexes.get(category);
          if (this.hasIndexContent(index)) {
            nodes.push(this.createCategoryNode(category));
          }
        }
        if (this.ignoredEntries.length > 0) nodes.push(this.createCategoryNode('ignored'));
        return nodes;
      }

      const nodes: ProjectNode[] = [];
      if (this.hasSource) nodes.push(this.createCategoryNode('sources'));
      if (this.hasTest) nodes.push(this.createCategoryNode('tests'));
      if (this.ignoredEntries.length > 0) nodes.push(this.createCategoryNode('ignored'));
      return nodes;
    }

    if (element instanceof ProjectGroupNode) {
      const nodes: ProjectNode[] = [];
      for (const category of CPP_PROJECT_CATEGORY_IDS) {
        const index = this.projectCategoryIndexes.get(element.projectRoot)?.get(category);
        if (this.hasIndexContent(index)) {
          nodes.push(this.createCategoryNode(category, element.projectRoot));
        }
      }
      return nodes;
    }

    if (element instanceof CategoryNode) {
      if (element.category === 'ignored') return this.getIgnoredChildren('');
      const index = this.getIndexForCategory(element.category, element.projectRoot);
      return this.getFromIndex(index, '', element.category, element.projectRoot);
    }

    if (element instanceof ProjDirectoryNode) {
      if (element.category === 'ignored') return this.getIgnoredChildren(element.dirPath);
      const index = this.getIndexForCategory(element.category, element.projectRoot);
      return this.getFromIndex(index, element.dirPath, element.category, element.projectRoot);
    }

    return [];
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this._onDidChangeTreeData.dispose();
  }

  private getFromIndex(index: Map<string, DirEntry>, dirPath: string, category: ViewCategory, projectRoot = ''): ProjectNode[] {
    const entry = index.get(dirPath);
    if (!entry) return [];
    const nodes: ProjectNode[] = [];
    for (const subdir of entry.subdirs) {
      const visibleDir = this.buildVisibleDirNode(index, subdir, dirPath);
      nodes.push(new ProjDirectoryNode(visibleDir.dirPath, category, this.workspaceRoot, projectRoot, visibleDir.label, visibleDir.parentDirPath));
    }
    for (const fileName of entry.files) {
      const relativePath = dirPath ? `${dirPath}/${fileName}` : fileName;
      const workspaceRelativePath = joinProjectPath(projectRoot, relativePath);
      nodes.push(new ProjFileNode(relativePath, this.workspaceRoot, this.shouldDimFile(workspaceRelativePath, category), projectRoot));
    }
    return nodes;
  }

  private async getIgnoredChildren(dirPath: string): Promise<ProjectNode[]> {
    if (this.isInsideIgnoredDir(dirPath)) {
      return this.readIgnoredDir(dirPath);
    }
    return this.getFromIndex(this.ignoredIndex, dirPath, 'ignored');
  }

  private async readIgnoredDir(dirRelative: string): Promise<ProjectNode[]> {
    const fullPath = path.join(this.workspaceRoot, dirRelative);
    try {
      const entries = (await fs.promises.readdir(fullPath, { withFileTypes: true }))
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      const dirEntries = entries.filter(e => e.isDirectory());
      const fileEntries = entries.filter(e => !e.isDirectory());
      const dirs = await Promise.all(
        dirEntries.map(async e => {
          const relative = `${dirRelative}/${e.name}`;
          const visibleDir = await this.buildVisibleFsDirNode(relative, dirRelative);
          return new ProjDirectoryNode(visibleDir.dirPath, 'ignored', this.workspaceRoot, '', visibleDir.label, visibleDir.parentDirPath);
        }),
      );
      const files = fileEntries.map(e => new ProjFileNode(`${dirRelative}/${e.name}`, this.workspaceRoot, false));
      return [...dirs, ...files];
    } catch {
      return [];
    }
  }

  private isInsideIgnoredDir(dirPath: string): boolean {
    if (!dirPath) return false;

    let current = dirPath;
    while (true) {
      if (this.ignoredDirs.has(current)) return true;
      const slash = current.lastIndexOf('/');
      if (slash === -1) return false;
      current = current.slice(0, slash);
    }
  }

  private toRelativePath(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file' || !this.workspaceRoot) return undefined;
    const relative = path.relative(this.workspaceRoot, uri.fsPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join('/');
  }

  private getProjectRootForPath(relativePath: string): string {
    return this.fileProjectRoots.get(relativePath) ?? '';
  }

  private getCategoryForPath(relativePath: string): ViewCategory | undefined {
    if (this.isIgnoredPath(relativePath)) return 'ignored';
    if (!this.hasFile(this.allIndex, relativePath)) return undefined;
    if (this.viewMode === 'merged') return 'all';
    if (this.viewMode === 'categorized') {
      return this.testFileSet.has(relativePath) ? 'tests' : 'sources';
    }
    return classifyCppProjectPath(relativePath, this.testFileSet.has(relativePath));
  }

  private async getParentForPath(relativePath: string, category: ViewCategory | undefined, projectRoot = ''): Promise<ProjectNode | undefined> {
    if (!category) return undefined;
    const parentDir = path.posix.dirname(relativePath);
    if (parentDir !== '.') {
      return this.createVisibleDirectoryNode(parentDir, category, projectRoot);
    }
    if (category === 'all') return undefined;
    return this.createCategoryNode(category, projectRoot);
  }

  private shouldDimFile(relativePath: string, category: ViewCategory): boolean {
    if (category === 'ignored') return false;
    if (this.viewMode === 'merged' && this.testFileSet.has(relativePath)) return shouldDimMergedTestFile(relativePath);
    if (this.viewMode === 'cpp-project' && category !== 'cppBuild' && isGeneratedProjectPath(relativePath)) return true;
    return false;
  }

  private createProjectGroupNode(projectRoot: string): ProjectGroupNode {
    const label = projectRoot ? path.posix.basename(projectRoot) : path.basename(this.workspaceRoot || 'workspace');
    return new ProjectGroupNode(projectRoot, label || projectRoot || 'workspace');
  }

  private createCategoryNode(category: RootCategory, projectRoot = ''): CategoryNode {
    const { label, icon } = this.getCategoryMeta(category);
    return new CategoryNode(category, label, icon, projectRoot);
  }

  private getCategoryMeta(category: RootCategory): { label: string; icon: string } {
    switch (category) {
      case 'sources':
        return { label: t('源码', 'Sources'), icon: 'file-code' };
      case 'tests':
        return { label: t('测试', 'Tests'), icon: 'beaker' };
      case 'ignored':
        return { label: t('已忽略', 'Ignored'), icon: 'circle-slash' };
      case 'cppModules':
        return { label: t('模块', 'Modules'), icon: 'symbol-module' };
      case 'cppIncludes':
        return { label: t('头文件', 'Headers'), icon: 'symbol-namespace' };
      case 'cppTests':
        return { label: t('测试', 'Tests'), icon: 'beaker' };
      case 'cppBuild':
        return { label: t('构建与工程文件', 'Build'), icon: 'tools' };
      case 'cppThirdParty':
        return { label: t('第三方依赖', 'Third-Party'), icon: 'package' };
      default:
        return { label: category, icon: 'folder' };
    }
  }

  private async createVisibleDirectoryNode(dirPath: string, category: ViewCategory, projectRoot = ''): Promise<ProjDirectoryNode> {
    const index = category === 'ignored' && !this.isInsideIgnoredDir(dirPath)
      ? this.ignoredIndex
      : this.getIndexForCategory(category, projectRoot);
    const info = category === 'ignored' && this.isInsideIgnoredDir(dirPath)
      ? await this.buildVisibleFsDirNode(dirPath, path.posix.dirname(dirPath) === '.' ? '' : path.posix.dirname(dirPath))
      : this.findVisibleDirNode(index, dirPath);
    if (info) return new ProjDirectoryNode(info.dirPath, category, this.workspaceRoot, projectRoot, info.label, info.parentDirPath);
    return new ProjDirectoryNode(dirPath, category, this.workspaceRoot, projectRoot, undefined, path.posix.dirname(dirPath) === '.' ? '' : path.posix.dirname(dirPath));
  }

  private buildVisibleDirNode(index: Map<string, DirEntry>, dirPath: string, parentDirPath: string): VisibleDirNodeInfo {
    let current = dirPath;
    const labels = [path.posix.basename(dirPath)];
    while (true) {
      const entry = index.get(current);
      if (!entry || entry.files.length > 0 || entry.subdirs.length !== 1) break;
      current = entry.subdirs[0];
      labels.push(path.posix.basename(current));
    }
    return { dirPath: current, label: labels.join('/'), parentDirPath };
  }

  private findVisibleDirNode(index: Map<string, DirEntry>, targetDirPath: string): VisibleDirNodeInfo | undefined {
    let parentDirPath = '';
    while (true) {
      const entry = index.get(parentDirPath);
      if (!entry) return undefined;
      const child = entry.subdirs.find(subdir => targetDirPath === subdir || targetDirPath.startsWith(`${subdir}/`));
      if (!child) return undefined;
      const visible = this.buildVisibleDirNode(index, child, parentDirPath);
      if (visible.dirPath === targetDirPath) return visible;
      if (!targetDirPath.startsWith(`${visible.dirPath}/`)) return visible;
      parentDirPath = visible.dirPath;
    }
  }

  private async buildVisibleFsDirNode(dirPath: string, parentDirPath: string): Promise<VisibleDirNodeInfo> {
    let current = dirPath;
    const labels = [path.posix.basename(dirPath)];
    while (true) {
      const fullPath = path.join(this.workspaceRoot, current);
      let entries: fs.Dirent[];
      try {
        entries = (await fs.promises.readdir(fullPath, { withFileTypes: true })).filter(entry => !entry.name.startsWith('.'));
      } catch {
        break;
      }
      const dirs = entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter(entry => !entry.isDirectory());
      if (files.length > 0 || dirs.length !== 1) break;
      current = `${current}/${dirs[0].name}`;
      labels.push(dirs[0].name);
    }
    return { dirPath: current, label: labels.join('/'), parentDirPath };
  }

  private hasFile(index: Map<string, DirEntry>, relativePath: string): boolean {
    const parentDir = path.posix.dirname(relativePath);
    const fileName = path.posix.basename(relativePath);
    const entry = index.get(parentDir === '.' ? '' : parentDir);
    return !!entry?.files.includes(fileName);
  }

  private hasIndexContent(index: Map<string, DirEntry> | undefined): boolean {
    if (!index) return false;
    const root = index.get('');
    return Boolean(root && (root.subdirs.length > 0 || root.files.length > 0));
  }

  private isIgnoredPath(relativePath: string): boolean {
    if (this.ignoredEntrySet.has(relativePath)) return true;
    const parentDir = path.posix.dirname(relativePath);
    return parentDir !== '.' && this.isInsideIgnoredDir(parentDir);
  }

  private getIndexForCategory(category: ViewCategory, projectRoot = ''): Map<string, DirEntry> {
    if (category === 'all') return this.allIndex;
    if (category === 'sources') return this.sourceIndex;
    if (category === 'tests') return this.testIndex;
    if (category === 'ignored') return this.ignoredIndex;
    if (isCppProjectCategory(category)) {
      if (this.showProjectGroups) return this.projectCategoryIndexes.get(projectRoot)?.get(category) ?? new Map<string, DirEntry>();
      return this.cppCategoryIndexes.get(category) ?? new Map<string, DirEntry>();
    }
    return new Map<string, DirEntry>();
  }

  private applyViewModeContext(): void {
    void vscode.commands.executeCommand('setContext', 'smartReferences.projectViewCategorized', this.viewMode === 'categorized');
    void vscode.commands.executeCommand('setContext', 'smartReferences.projectViewMode', this.viewMode);
    void vscode.commands.executeCommand('setContext', 'smartReferences.projectViewSupportsCpp', this.cppProjectDetected);
  }

  private execGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const gitArgs = ['-c', `safe.directory=${this.workspaceRoot}`, ...args];
      execFile('git', gitArgs, { cwd: this.workspaceRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }
}
