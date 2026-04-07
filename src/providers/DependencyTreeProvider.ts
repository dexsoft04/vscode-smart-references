import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import {
  DependencyResolver,
  ResolvedDependency,
  DependencyEcosystem,
  DependencyType,
} from '../core/DependencyResolver';

type DepNode = EcosystemNode | DependencyNode | FileEntryNode;

interface DependencyGroup {
  ecosystem: DependencyEcosystem;
  label: string;
  deps: ResolvedDependency[];
}

const ECOSYSTEM_ORDER: DependencyEcosystem[] = ['node', 'go', 'python', 'csharp'];
const ECOSYSTEM_LABELS: Record<DependencyEcosystem, string> = {
  node: 'Node.js',
  go: 'Go',
  python: 'Python',
  csharp: 'C#',
};

const TYPE_ORDER: DependencyType[] = ['direct', 'peer', 'optional', 'dev', 'indirect'];
const TYPE_LABELS: Record<DependencyType, string> = {
  direct: '',
  dev: 'dev',
  peer: 'peer',
  optional: 'optional',
  indirect: 'indirect',
};

export class EcosystemNode extends vscode.TreeItem {
  constructor(public readonly group: DependencyGroup, sdkVersion?: string) {
    super(group.label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = sdkVersion
      ? `${sdkVersion} · ${group.deps.length} deps`
      : `${group.deps.length} deps`;
    this.contextValue = 'dependencyGroup';
    this.iconPath = new vscode.ThemeIcon(iconForEcosystem(group.ecosystem));
  }
}

export class DependencyNode extends vscode.TreeItem {
  constructor(public readonly dep: ResolvedDependency) {
    super(
      dep.name,
      dep.localDir
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    const tags = dependencyTags(dep);
    const declared = dep.specifiers?.[0] && dep.specifiers[0] !== dep.version
      ? `  declared ${dep.specifiers[0]}`
      : '';
    this.description = dep.version + declared + (tags ? `  ${tags}` : '');
    this.tooltip = buildDependencyTooltip(dep);
    this.iconPath = dep.localDir
      ? new vscode.ThemeIcon('package')
      : new vscode.ThemeIcon('package', new vscode.ThemeColor('disabledForeground'));
    this.contextValue = 'dependency';
  }
}

export class FileEntryNode extends vscode.TreeItem {
  constructor(
    public readonly fsPath: string,
    public readonly isDirectory: boolean,
  ) {
    super(
      path.basename(fsPath),
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.resourceUri = vscode.Uri.file(fsPath);
    this.contextValue = isDirectory ? 'depDir' : 'depFile';

    if (!isDirectory) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [vscode.Uri.file(fsPath)],
      };
    }
  }
}

export class DependencyTreeProvider implements vscode.TreeDataProvider<DepNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<DepNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groups: DependencyGroup[] = [];
  private sdkVersions = new Map<DependencyEcosystem, string>();

  constructor(
    private readonly resolvers: DependencyResolver[],
    private readonly log: vscode.OutputChannel,
  ) {}

  async refresh(): Promise<void> {
    this.log.appendLine('[dep-tree] refresh started');

    const collected: ResolvedDependency[] = [];
    for (const resolver of this.resolvers) {
      const ok = await resolver.detect();
      this.log.appendLine(`[dep-tree] resolver ${resolver.id} detect=${ok}`);
      if (!ok) continue;

      const resolved = await resolver.resolve();
      this.log.appendLine(`[dep-tree] resolver ${resolver.id} resolved=${resolved.length}`);
      collected.push(...resolved);
    }

    this.groups = buildGroups(collected);

    const ecosystems = this.groups.map(g => g.ecosystem);
    const versionEntries = await Promise.all(
      ecosystems.map(async (eco): Promise<[DependencyEcosystem, string]> => {
        const ver = await detectSdkVersion(eco);
        return [eco, ver];
      }),
    );
    this.sdkVersions.clear();
    for (const [eco, ver] of versionEntries) {
      if (ver) this.sdkVersions.set(eco, ver);
    }

    this.log.appendLine(`[dep-tree] groups=${this.groups.length} deps=${collected.length}`);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DepNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DepNode): DepNode[] {
    if (!element) {
      return this.groups.map(group => new EcosystemNode(group, this.sdkVersions.get(group.ecosystem)));
    }

    if (element instanceof EcosystemNode) {
      return element.group.deps.map(dep => new DependencyNode(dep));
    }

    if (element instanceof DependencyNode) {
      if (!element.dep.localDir) return [];
      return readDirEntries(element.dep.localDir);
    }

    if (element instanceof FileEntryNode && element.isDirectory) {
      return readDirEntries(element.fsPath);
    }

    return [];
  }

  async searchAndOpen(): Promise<void> {
    const allDeps = this.groups.flatMap(group => group.deps);
    if (allDeps.length === 0) {
      vscode.window.showInformationMessage('No dependencies loaded. Try refreshing the Dependencies panel.');
      return;
    }

    interface DepItem extends vscode.QuickPickItem {
      dep: ResolvedDependency;
    }

    const items: DepItem[] = allDeps.map(dep => ({
      label: `$(package) ${dep.name}`,
      description: `${ECOSYSTEM_LABELS[dep.ecosystem]}  ${dep.version}${dependencyTags(dep) ? `  ${dependencyTags(dep)}` : ''}`,
      detail: dep.localDir ?? missingLabel(dep),
      dep,
      alwaysShow: true,
    }));

    const qp = vscode.window.createQuickPick<DepItem>();
    qp.title = 'Search Dependencies';
    qp.placeholder = 'Type to filter dependencies';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = items;

    qp.onDidAccept(async () => {
      const selected = qp.selectedItems[0];
      qp.hide();
      if (!selected?.dep.localDir) {
        vscode.window.showWarningMessage(`${selected?.dep.name} is ${missingStateText(selected.dep)}.`);
        return;
      }
      const targetUri = findEntryFile(selected.dep.localDir);
      if (targetUri) {
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showWarningMessage(`No source files found in ${selected.dep.localDir}`);
      }
    });

    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

function buildGroups(deps: ResolvedDependency[]): DependencyGroup[] {
  const byEcosystem = new Map<DependencyEcosystem, ResolvedDependency[]>();

  for (const dep of deps) {
    if (!byEcosystem.has(dep.ecosystem)) byEcosystem.set(dep.ecosystem, []);
    byEcosystem.get(dep.ecosystem)!.push(dep);
  }

  const groups: DependencyGroup[] = [];
  for (const ecosystem of ECOSYSTEM_ORDER) {
    const groupDeps = byEcosystem.get(ecosystem);
    if (!groupDeps || groupDeps.length === 0) continue;
    groupDeps.sort(compareDependencies);
    groups.push({
      ecosystem,
      label: ECOSYSTEM_LABELS[ecosystem],
      deps: groupDeps,
    });
  }

  for (const [ecosystem, groupDeps] of byEcosystem.entries()) {
    if (ECOSYSTEM_ORDER.includes(ecosystem)) continue;
    groupDeps.sort(compareDependencies);
    groups.push({
      ecosystem,
      label: ECOSYSTEM_LABELS[ecosystem],
      deps: groupDeps,
    });
  }

  return groups;
}

function compareDependencies(a: ResolvedDependency, b: ResolvedDependency): number {
  const aRank = primaryTypeRank(a);
  const bRank = primaryTypeRank(b);
  if (aRank !== bRank) return aRank - bRank;
  return a.name.localeCompare(b.name);
}

function primaryTypeRank(dep: ResolvedDependency): number {
  const tags: DependencyType[] = dep.dependencyTypes.length > 0 ? dep.dependencyTypes : ['direct'];
  return Math.min(...tags.map(tag => TYPE_ORDER.indexOf(tag)).filter(idx => idx >= 0));
}

function dependencyTags(dep: ResolvedDependency): string {
  const parts = dep.dependencyTypes
    .map(type => TYPE_LABELS[type])
    .filter(Boolean);
  if (dep.workspaceLocal) parts.unshift('workspace');
  if (!dep.localDir) parts.push(missingLabel(dep));
  return parts.join('  ');
}

function missingLabel(dep: ResolvedDependency): string {
  return dep.ecosystem === 'node' ? '(not installed)' : '(not downloaded)';
}

function missingStateText(dep: ResolvedDependency): string {
  return dep.ecosystem === 'node' ? 'not installed' : 'not downloaded';
}

function buildDependencyTooltip(dep: ResolvedDependency): string {
  const lines = [
    `${ECOSYSTEM_LABELS[dep.ecosystem]} - ${dep.name}`,
    `Version: ${dep.version}`,
  ];
  if (dep.specifiers && dep.specifiers.length > 0) {
    lines.push(`Declared: ${dep.specifiers.join(', ')}`);
  }
  if (dep.dependencyTypes.length > 0) {
    const labels = dep.dependencyTypes.map(type => TYPE_LABELS[type] || type).filter(Boolean);
    if (labels.length > 0) lines.push(`Tags: ${labels.join(', ')}`);
  }
  if (dep.workspaceLocal) lines.push('Workspace local package');
  if (dep.localDir) {
    lines.push(dep.localDir);
  } else {
    lines.push(missingLabel(dep));
  }
  if (dep.sourceManifests.length > 0) {
    lines.push(`Source: ${dep.sourceManifests.join(', ')}`);
  }
  return lines.join('\n');
}

function iconForEcosystem(ecosystem: DependencyEcosystem): string {
  switch (ecosystem) {
    case 'node': return 'nodejs';
    case 'go': return 'package';
    case 'python': return 'symbol-module';
    case 'csharp': return 'symbol-namespace';
  }
}

function findEntryFile(dirPath: string): vscode.Uri | undefined {
  const packageJsonPath = path.join(dirPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const fromPackageJson = findNodeEntryFile(dirPath, packageJsonPath);
    if (fromPackageJson) return vscode.Uri.file(fromPackageJson);
  }

  try {
    const entries = fs.readdirSync(dirPath);
    const sourceFiles = entries.filter(f =>
      !f.startsWith('.') &&
      !f.endsWith('_test.go') &&
      !f.endsWith('Tests.cs') &&
      !f.endsWith('.Designer.cs') &&
      (f.endsWith('.go') || f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.py') || f.endsWith('.cs')),
    );
    if (sourceFiles.length === 0) return undefined;
    const preferred = sourceFiles.find(f =>
      f === 'doc.go' || f === 'index.ts' || f === 'index.js' || f === '__init__.py',
    ) ?? sourceFiles.sort((a, b) => a.length - b.length)[0];
    return vscode.Uri.file(path.join(dirPath, preferred));
  } catch {
    return undefined;
  }
}

function findNodeEntryFile(dirPath: string, packageJsonPath: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      types?: string;
      typings?: string;
      module?: string;
      main?: string;
    };
    const candidates = [manifest.types, manifest.typings, manifest.module, manifest.main].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    for (const candidate of candidates) {
      const resolved = path.resolve(dirPath, candidate);
      const file = resolveFileCandidate(resolved);
      if (file) return file;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveFileCandidate(candidate: string): string | undefined {
  const tries = [
    candidate,
    `${candidate}.d.ts`,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.js`,
    `${candidate}.jsx`,
    `${candidate}.mjs`,
    `${candidate}.cjs`,
    path.join(candidate, 'index.d.ts'),
    path.join(candidate, 'index.ts'),
    path.join(candidate, 'index.js'),
  ];

  for (const file of tries) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return undefined;
}

function readDirEntries(dirPath: string): FileEntryNode[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs: FileEntryNode[] = [];
    const files: FileEntryNode[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        dirs.push(new FileEntryNode(fullPath, true));
      } else {
        files.push(new FileEntryNode(fullPath, false));
      }
    }

    dirs.sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)));
    files.sort((a, b) => path.basename(a.fsPath).localeCompare(path.basename(b.fsPath)));

    return [...dirs, ...files];
  } catch {
    return [];
  }
}

// ── SDK version detection ───────────────────────────────────────────────────

const SDK_COMMANDS: Record<DependencyEcosystem, { cmd: string; args: string[]; parse: (out: string) => string }> = {
  node: {
    cmd: 'node',
    args: ['-v'],
    parse: out => out.trim(),  // "v18.19.1"
  },
  go: {
    cmd: 'go',
    args: ['version'],
    parse: out => {
      const m = out.match(/go(\d+\.\d+\.\d+)/);
      return m ? `go${m[1]}` : out.trim().split(/\s+/)[2] ?? '';
    },
  },
  python: {
    cmd: 'python3',
    args: ['--version'],
    parse: out => {
      const m = out.match(/(\d+\.\d+\.\d+)/);
      return m ? m[1] : '';
    },
  },
  csharp: {
    cmd: 'dotnet',
    args: ['--version'],
    parse: out => out.trim(),
  },
};

function detectSdkVersion(ecosystem: DependencyEcosystem): Promise<string> {
  const spec = SDK_COMMANDS[ecosystem];
  if (!spec) return Promise.resolve('');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return new Promise(resolve => {
    try {
      const proc = execFile(spec.cmd, spec.args, { timeout: 5000, cwd }, (err, stdout) => {
        if (err) { resolve(''); return; }
        resolve(spec.parse(stdout));
      });
      proc.stdin?.end();
    } catch {
      resolve('');
    }
  });
}
