import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { TestFileDetector } from '../analyzers/TestFileDetector';

// ── Directory index (pre-built for O(1) getChildren) ─────────────────────────

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

// ── Test file decoration ─────────────────────────────────────────────────────

export const PROJ_TEST_SCHEME = 'proj-test';

export class ProjectTestDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== PROJ_TEST_SCHEME) return undefined;
    return { color: new vscode.ThemeColor('disabledForeground') };
  }
}

/** Extract real file URI from a tree item (handles proj-test scheme). */
export function resolveRealUri(item: vscode.TreeItem): vscode.Uri | undefined {
  if (!item.resourceUri) return undefined;
  if (item.resourceUri.scheme === PROJ_TEST_SCHEME) {
    return vscode.Uri.file(item.resourceUri.path);
  }
  return item.resourceUri;
}

// ── Tree node types ───────────────────────────────────────────────────────────

type ProjectNode = CategoryNode | ProjDirectoryNode | ProjFileNode;
type ViewCategory = 'sources' | 'tests' | 'ignored' | 'all';

class CategoryNode extends vscode.TreeItem {
  constructor(
    public readonly category: 'sources' | 'tests' | 'ignored',
    label: string,
    icon: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = `projectCategory-${category}`;
  }
}

class ProjDirectoryNode extends vscode.TreeItem {
  constructor(
    public readonly dirPath: string,
    public readonly category: ViewCategory,
    workspaceRoot: string,
  ) {
    super(path.basename(dirPath), vscode.TreeItemCollapsibleState.Collapsed);
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, dirPath));
    this.contextValue = 'projectDir';
    this.tooltip = dirPath;
  }
}

class ProjFileNode extends vscode.TreeItem {
  constructor(
    public readonly relativePath: string,
    workspaceRoot: string,
    isTest: boolean,
  ) {
    super(path.basename(relativePath), vscode.TreeItemCollapsibleState.None);
    const fullPath = path.join(workspaceRoot, relativePath);
    const fileUri = vscode.Uri.file(fullPath);

    if (isTest) {
      this.resourceUri = vscode.Uri.from({ scheme: PROJ_TEST_SCHEME, path: fileUri.path });
    } else {
      this.resourceUri = fileUri;
    }

    this.command = { command: 'vscode.open', title: 'Open File', arguments: [fileUri] };
    this.contextValue = 'projectFile';
    this.tooltip = relativePath;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class ProjectExplorerProvider implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<ProjectNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sourceIndex = new Map<string, DirEntry>();
  private testIndex = new Map<string, DirEntry>();
  private allIndex = new Map<string, DirEntry>();
  private ignoredIndex = new Map<string, DirEntry>();
  private ignoredDirs = new Set<string>();
  private ignoredEntrySet = new Set<string>();
  private testFileSet = new Set<string>();
  private ignoredEntries: string[] = [];
  private hasSource = false;
  private hasTest = false;
  private viewMode: 'categorized' | 'merged' = 'merged';
  private workspaceRoot: string;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private visible = false;
  private dirty = true;

  constructor(
    private testDetector: TestFileDetector,
    private log: vscode.OutputChannel,
  ) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  toggleViewMode(): void {
    this.viewMode = this.viewMode === 'categorized' ? 'merged' : 'categorized';
    vscode.commands.executeCommand(
      'setContext', 'smartReferences.projectViewCategorized', this.viewMode === 'categorized',
    );
    this._onDidChangeTreeData.fire();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.dirty) {
      void this.refresh();
    }
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
    this.dirty = false;

    try {
      const [trackedOutput, ignoredOutput] = await Promise.all([
        this.execGit('git ls-files'),
        this.execGit('git ls-files --others --ignored --exclude-standard --directory'),
      ]);

      const allTracked = trackedOutput.split('\n').filter(Boolean);
      this.ignoredEntries = ignoredOutput.split('\n').filter(Boolean);
      const ignoredTree = buildIgnoredTree(this.ignoredEntries);
      this.ignoredEntrySet = new Set(this.ignoredEntries.map(entry => entry.replace(/\/$/, '')));

      const sourceFiles: string[] = [];
      const testFiles: string[] = [];
      this.testFileSet = new Set();
      for (const file of allTracked) {
        const uri = vscode.Uri.file(path.join(this.workspaceRoot, file));
        if (this.testDetector.isTestFile(uri)) {
          testFiles.push(file);
          this.testFileSet.add(file);
        } else {
          sourceFiles.push(file);
        }
      }

      this.sourceIndex = buildDirIndex(sourceFiles);
      this.testIndex = buildDirIndex(testFiles);
      this.allIndex = buildDirIndex(allTracked);
      this.ignoredIndex = ignoredTree.index;
      this.ignoredDirs = ignoredTree.ignoredDirs;
      this.hasSource = sourceFiles.length > 0;
      this.hasTest = testFiles.length > 0;

      this.log.appendLine(
        `[project-explorer] refresh: ${sourceFiles.length} sources, ` +
        `${testFiles.length} tests, ${this.ignoredEntries.length} ignored`,
      );
    } catch (err) {
      this.log.appendLine(`[project-explorer] refresh error: ${String(err)}`);
      this.sourceIndex = new Map();
      this.testIndex = new Map();
      this.allIndex = new Map();
      this.ignoredIndex = new Map();
      this.ignoredDirs = new Set();
      this.ignoredEntrySet = new Set();
      this.testFileSet = new Set();
      this.ignoredEntries = [];
      this.hasSource = false;
      this.hasTest = false;
    }

    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    return element;
  }

  getParent(element: ProjectNode): ProjectNode | undefined {
    if (element instanceof CategoryNode) return undefined;

    if (element instanceof ProjDirectoryNode) {
      return this.getParentForPath(element.dirPath, element.category);
    }

    return this.getParentForPath(element.relativePath, this.getCategoryForPath(element.relativePath));
  }

  getRevealTarget(uri: vscode.Uri): ProjectNode | undefined {
    const relativePath = this.toRelativePath(uri);
    if (!relativePath) return undefined;
    const category = this.getCategoryForPath(relativePath);
    if (!category) return undefined;
    const isTest = this.viewMode === 'merged' && this.testFileSet.has(relativePath);
    return new ProjFileNode(relativePath, this.workspaceRoot, isTest);
  }

  getChildren(element?: ProjectNode): ProjectNode[] {
    if (!element) {
      if (this.viewMode === 'merged') {
        const nodes = this.getFromIndex(this.allIndex, '', 'all');
        if (this.ignoredEntries.length > 0) {
          nodes.push(new CategoryNode('ignored', 'Ignored', 'circle-slash'));
        }
        return nodes;
      }
      const nodes: ProjectNode[] = [];
      if (this.hasSource) nodes.push(new CategoryNode('sources', 'Sources', 'file-code'));
      if (this.hasTest) nodes.push(new CategoryNode('tests', 'Tests', 'beaker'));
      if (this.ignoredEntries.length > 0) nodes.push(new CategoryNode('ignored', 'Ignored', 'circle-slash'));
      return nodes;
    }

    if (element instanceof CategoryNode) {
      if (element.category === 'ignored') return this.getIgnoredChildren('');
      const index = element.category === 'sources' ? this.sourceIndex : this.testIndex;
      return this.getFromIndex(index, '', element.category);
    }

    if (element instanceof ProjDirectoryNode) {
      if (element.category === 'ignored') return this.getIgnoredChildren(element.dirPath);
      const index = element.category === 'all'
        ? this.allIndex
        : element.category === 'sources' ? this.sourceIndex : this.testIndex;
      return this.getFromIndex(index, element.dirPath, element.category);
    }

    return [];
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this._onDidChangeTreeData.dispose();
  }

  // ── Tree building (O(1) per call using pre-built index) ─────────────────

  private getFromIndex(index: Map<string, DirEntry>, dirPath: string, category: ViewCategory): ProjectNode[] {
    const entry = index.get(dirPath);
    if (!entry) return [];
    const dimTests = this.viewMode === 'merged';

    const nodes: ProjectNode[] = [];
    for (const subdir of entry.subdirs) {
      nodes.push(new ProjDirectoryNode(subdir, category, this.workspaceRoot));
    }
    for (const fileName of entry.files) {
      const relativePath = dirPath ? `${dirPath}/${fileName}` : fileName;
      const isTest = dimTests && this.testFileSet.has(relativePath);
      nodes.push(new ProjFileNode(relativePath, this.workspaceRoot, isTest));
    }
    return nodes;
  }

  private getIgnoredChildren(dirPath: string): ProjectNode[] {
    if (this.isInsideIgnoredDir(dirPath)) {
      return this.readIgnoredDir(dirPath);
    }
    return this.getFromIndex(this.ignoredIndex, dirPath, 'ignored');
  }

  private readIgnoredDir(dirRelative: string): ProjectNode[] {
    const fullPath = path.join(this.workspaceRoot, dirRelative);
    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      const dirs: ProjectNode[] = [];
      const files: ProjectNode[] = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const relative = `${dirRelative}/${e.name}`;
        if (e.isDirectory()) {
          dirs.push(new ProjDirectoryNode(relative, 'ignored', this.workspaceRoot));
        } else {
          files.push(new ProjFileNode(relative, this.workspaceRoot, false));
        }
      }
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

  private getCategoryForPath(relativePath: string): ViewCategory | undefined {
    if (this.isIgnoredPath(relativePath)) return 'ignored';
    if (this.hasFile(this.allIndex, relativePath)) {
      if (this.viewMode === 'merged') return 'all';
      return this.testFileSet.has(relativePath) ? 'tests' : 'sources';
    }
    return undefined;
  }

  private getParentForPath(relativePath: string, category: ViewCategory | undefined): ProjectNode | undefined {
    if (!category) return undefined;
    const parentDir = path.posix.dirname(relativePath);
    if (parentDir !== '.') {
      return new ProjDirectoryNode(parentDir, category, this.workspaceRoot);
    }
    if (category === 'all') return undefined;
    return this.createCategoryNode(category);
  }

  private createCategoryNode(category: 'sources' | 'tests' | 'ignored'): CategoryNode {
    if (category === 'sources') return new CategoryNode('sources', 'Sources', 'file-code');
    if (category === 'tests') return new CategoryNode('tests', 'Tests', 'beaker');
    return new CategoryNode('ignored', 'Ignored', 'circle-slash');
  }

  private hasFile(index: Map<string, DirEntry>, relativePath: string): boolean {
    const parentDir = path.posix.dirname(relativePath);
    const fileName = path.posix.basename(relativePath);
    const entry = index.get(parentDir === '.' ? '' : parentDir);
    return !!entry?.files.includes(fileName);
  }

  private isIgnoredPath(relativePath: string): boolean {
    if (this.ignoredEntrySet.has(relativePath)) return true;
    const parentDir = path.posix.dirname(relativePath);
    return parentDir !== '.' && this.isInsideIgnoredDir(parentDir);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private execGit(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { cwd: this.workspaceRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }
}
