import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';

type SearchNode = WorkspaceNode | DirectoryNode | FileNode | MatchNode;

interface TextSearchMatch {
  readonly workspaceName: string;
  readonly workspaceUri: vscode.Uri;
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly directoryPath: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly range: vscode.Range;
}

interface WorkspaceBucket {
  readonly folder: vscode.WorkspaceFolder;
  readonly matches: TextSearchMatch[];
}

interface DirectoryEntry {
  readonly fullPath: string;
  readonly name: string;
  readonly matches: TextSearchMatch[];
}

interface FileBucket {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly fileName: string;
  readonly matches: TextSearchMatch[];
}

interface RgJsonMessage {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

class WorkspaceNode extends vscode.TreeItem {
  constructor(public readonly bucket: WorkspaceBucket) {
    super(bucket.folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${bucket.matches.length}`;
    this.tooltip = bucket.folder.uri.fsPath;
    this.iconPath = new vscode.ThemeIcon('root-folder');
    this.contextValue = 'textSearchWorkspace';
  }
}

class DirectoryNode extends vscode.TreeItem {
  constructor(
    public readonly workspace: WorkspaceBucket,
    public readonly relativeDirPath: string,
    public readonly name: string,
    public readonly matches: TextSearchMatch[],
  ) {
    super(name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${matches.length}`;
    this.tooltip = relativeDirPath || '.';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.contextValue = 'textSearchDirectory';
  }
}

class FileNode extends vscode.TreeItem {
  constructor(public readonly bucket: FileBucket) {
    super(bucket.fileName, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${bucket.matches.length}`;
    this.tooltip = bucket.relativePath;
    this.resourceUri = bucket.uri;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = 'textSearchFile';
  }
}

class MatchNode extends vscode.TreeItem {
  constructor(public readonly match: TextSearchMatch) {
    super(match.lineText.trim() || '(blank line)', vscode.TreeItemCollapsibleState.None);
    this.description = `:${match.lineNumber}`;
    this.tooltip = new vscode.MarkdownString(
      `**${match.relativePath}:${match.lineNumber}**\n\n`
      + '```plaintext\n'
      + `${match.lineText}\n`
      + '```',
    );
    this.resourceUri = match.uri;
    this.iconPath = new vscode.ThemeIcon('search');
    this.command = {
      command: 'smartReferences.previewReference',
      title: 'Preview Search Match',
      arguments: [match.uri, match.range],
    };
    this.contextValue = 'textSearchMatch';
  }
}

function splitWorkspaceAndRelative(filePath: string): { folder: vscode.WorkspaceFolder; relativePath: string } | undefined {
  const uri = vscode.Uri.file(filePath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const relativePath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');
  return { folder, relativePath };
}

function findMatchRange(lineText: string, query: string, lineNumber: number): vscode.Range {
  const caseSensitive = /[A-Z]/.test(query);
  const haystack = caseSensitive ? lineText : lineText.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const index = haystack.indexOf(needle);
  const start = index >= 0 ? index : 0;
  const end = index >= 0 ? index + query.length : Math.min(lineText.length, start + Math.max(query.length, 1));
  return new vscode.Range(lineNumber - 1, start, lineNumber - 1, end);
}

function parseRgOutput(rawOutput: string, query: string): TextSearchMatch[] {
  const matches: TextSearchMatch[] = [];
  const lines = rawOutput.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let message: RgJsonMessage;
    try {
      message = JSON.parse(line) as RgJsonMessage;
    } catch {
      continue;
    }
    if (message.type !== 'match' || !message.data?.path?.text || !message.data?.lines?.text || !message.data.line_number) {
      continue;
    }
    const filePath = message.data.path.text;
    const workspaceInfo = splitWorkspaceAndRelative(filePath);
    if (!workspaceInfo) continue;
    const lineText = message.data.lines.text.replace(/\r?\n$/, '');
    const relativePath = workspaceInfo.relativePath;
    matches.push({
      workspaceName: workspaceInfo.folder.name,
      workspaceUri: workspaceInfo.folder.uri,
      uri: vscode.Uri.file(filePath),
      relativePath,
      directoryPath: path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
      lineNumber: message.data.line_number,
      lineText,
      range: findMatchRange(lineText, query, message.data.line_number),
    });
  }
  return matches;
}

function groupMatchesByWorkspace(matches: TextSearchMatch[]): WorkspaceBucket[] {
  const buckets = new Map<string, WorkspaceBucket>();
  for (const match of matches) {
    const key = match.workspaceUri.toString();
    const folder = vscode.workspace.getWorkspaceFolder(match.workspaceUri) ?? {
      uri: match.workspaceUri,
      name: match.workspaceName,
      index: 0,
    };
    const bucket = buckets.get(key) ?? { folder, matches: [] };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.folder.name.localeCompare(b.folder.name));
}

function listChildDirectories(matches: TextSearchMatch[], parentDirPath: string): DirectoryEntry[] {
  const buckets = new Map<string, TextSearchMatch[]>();
  for (const match of matches) {
    if (!match.directoryPath) continue;
    if (parentDirPath) {
      if (match.directoryPath === parentDirPath || !match.directoryPath.startsWith(parentDirPath + '/')) continue;
      const remainder = match.directoryPath.slice(parentDirPath.length + 1);
      const childName = remainder.split('/')[0];
      const childPath = `${parentDirPath}/${childName}`;
      const bucket = buckets.get(childPath) ?? [];
      bucket.push(match);
      buckets.set(childPath, bucket);
      continue;
    }
    const childName = match.directoryPath.split('/')[0];
    const childPath = childName;
    const bucket = buckets.get(childPath) ?? [];
    bucket.push(match);
    buckets.set(childPath, bucket);
  }
  return [...buckets.entries()]
    .map(([fullPath, bucketMatches]) => ({
      fullPath,
      name: path.posix.basename(fullPath),
      matches: bucketMatches,
    }))
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

function listFilesAtDirectory(matches: TextSearchMatch[], directoryPath: string): FileBucket[] {
  const buckets = new Map<string, FileBucket>();
  for (const match of matches) {
    if (match.directoryPath !== directoryPath) continue;
    const key = match.uri.toString();
    const bucket = buckets.get(key) ?? {
      uri: match.uri,
      relativePath: match.relativePath,
      fileName: path.basename(match.uri.fsPath),
      matches: [],
    };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function executeRg(query: string): Promise<TextSearchMatch[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    throw new Error('No workspace folder is open');
  }
  const args = ['--json', '--line-number', '--fixed-strings', '--smart-case', query, ...folders.map(folder => folder.uri.fsPath)];
  return await new Promise<TextSearchMatch[]>((resolve, reject) => {
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => reject(err));
    child.on('close', code => {
      if (code !== 0 && code !== 1) {
        reject(new Error(stderr.trim() || `rg exited with code ${code}`));
        return;
      }
      resolve(parseRgOutput(stdout, query));
    });
  });
}

export class TextSearchTreeProvider implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SearchNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private query = '';
  private matches: TextSearchMatch[] = [];

  private buildWorkspaceChildren(bucket: WorkspaceBucket): SearchNode[] {
    const rootDirectories = listChildDirectories(bucket.matches, '');
    const rootFiles = listFilesAtDirectory(bucket.matches, '');
    return [
      ...rootDirectories.map(entry => new DirectoryNode(bucket, entry.fullPath, entry.name, entry.matches)),
      ...rootFiles.map(fileBucket => new FileNode(fileBucket)),
    ];
  }

  getTreeItem(element: SearchNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SearchNode): Promise<SearchNode[]> {
    if (!element) {
      const workspaces = groupMatchesByWorkspace(this.matches);
      if (workspaces.length === 1) return this.buildWorkspaceChildren(workspaces[0]);
      return workspaces.map(bucket => new WorkspaceNode(bucket));
    }
    if (element instanceof WorkspaceNode) {
      return this.buildWorkspaceChildren(element.bucket);
    }
    if (element instanceof DirectoryNode) {
      const childDirectories = listChildDirectories(element.matches, element.relativeDirPath);
      const childFiles = listFilesAtDirectory(element.matches, element.relativeDirPath);
      return [
        ...childDirectories.map(entry => new DirectoryNode(element.workspace, entry.fullPath, entry.name, entry.matches)),
        ...childFiles.map(bucket => new FileNode(bucket)),
      ];
    }
    if (element instanceof FileNode) {
      return element.bucket.matches
        .slice()
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map(match => new MatchNode(match));
    }
    return [];
  }

  getTitle(): string {
    if (!this.query) return 'Text Search';
    return `Text Search: ${this.query}`;
  }

  hasResults(): boolean {
    return this.matches.length > 0;
  }

  getQuery(): string {
    return this.query;
  }

  clear(): void {
    this.query = '';
    this.matches = [];
    this.onDidChangeTreeDataEmitter.fire();
  }

  async search(query: string): Promise<void> {
    const normalized = query.trim();
    if (!normalized) {
      this.clear();
      return;
    }
    const matches = await executeRg(normalized);
    this.query = normalized;
    this.matches = matches;
    this.onDidChangeTreeDataEmitter.fire();
  }

  async refresh(): Promise<void> {
    if (!this.query) return;
    await this.search(this.query);
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }
}
