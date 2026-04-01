import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  DependencyResolver,
  ResolvedDependency,
  DependencyType,
} from './DependencyResolver';
import {
  parsePackageManifest,
  workspacePatternToManifestGlob,
  resolveNodePackageDir,
  readNodePackageVersion,
  parsePackageLock,
  parsePnpmLock,
  parseYarnLock,
  resolvePackageLockVersion,
  resolvePnpmLockVersion,
  resolveYarnLockVersion,
} from './NodeDependencyUtils';

type LockKind = 'package-lock' | 'npm-shrinkwrap' | 'pnpm' | 'yarn';

interface WorkspaceManifestInfo {
  rootDir: string;
  manifestPath: string;
  packageName?: string;
}

interface LockContext {
  kind?: LockKind;
  packageLock?: ReturnType<typeof parsePackageLock>;
  pnpmLock?: ReturnType<typeof parsePnpmLock>;
  yarnLock?: ReturnType<typeof parseYarnLock>;
}

export class NodeDependencyResolver implements DependencyResolver {
  readonly id = 'node' as const;
  readonly displayName = 'Node.js';
  readonly watchPatterns = [
    '**/package.json',
    '**/package-lock.json',
    '**/npm-shrinkwrap.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
  ];

  async detect(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return false;

    for (const folder of folders) {
      const root = folder.uri.fsPath;
      if (
        fs.existsSync(path.join(root, 'package.json')) ||
        fs.existsSync(path.join(root, 'package-lock.json')) ||
        fs.existsSync(path.join(root, 'npm-shrinkwrap.json')) ||
        fs.existsSync(path.join(root, 'pnpm-lock.yaml')) ||
        fs.existsSync(path.join(root, 'yarn.lock'))
      ) {
        return true;
      }
    }

    return false;
  }

  async resolve(): Promise<ResolvedDependency[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    const seen = new Map<string, ResolvedDependency>();

    for (const folder of folders) {
      const rootDir = folder.uri.fsPath;
      const manifests = await collectWorkspaceManifests(folder);
      const workspaceByName = buildWorkspacePackageMap(manifests);
      const workspaceRoots = manifests.map(manifest => path.dirname(manifest.manifestPath));
      const lockContext = loadLockContext(rootDir);

      for (const manifestInfo of manifests) {
        let manifestText: string;
        try {
          manifestText = fs.readFileSync(manifestInfo.manifestPath, 'utf8');
        } catch {
          continue;
        }

        let parsedManifest;
        try {
          parsedManifest = parsePackageManifest(manifestText);
        } catch {
          continue;
        }

        const manifestDir = path.dirname(manifestInfo.manifestPath);
        const importerPath = normalizeImporterPath(path.relative(rootDir, manifestDir));

        for (const rawDep of parsedManifest.dependencies) {
          const localResolution = resolveLocalSpecifier(rawDep.specifier, manifestDir, workspaceByName, workspaceRoots, rawDep.name);
          const localDir = localResolution?.localDir ?? resolveNodePackageDir(manifestDir, rawDep.name);
          const workspaceLocal = localResolution?.workspaceLocal ?? false;
          const resolvedVersion = localDir
            ? readNodePackageVersion(localDir)
            : resolveLockVersion(lockContext, importerPath, rawDep.name, rawDep.specifier);
          const version = resolvedVersion ?? rawDep.specifier;

          mergeDependency(seen, {
            ecosystem: 'node',
            name: rawDep.name,
            version,
            localDir,
            dependencyTypes: [rawDep.dependencyType],
            sourceManifests: [manifestInfo.manifestPath],
            workspaceLocal,
            specifiers: [rawDep.specifier],
          });
        }
      }
    }

    return Array.from(seen.values());
  }
}

async function collectWorkspaceManifests(folder: vscode.WorkspaceFolder): Promise<WorkspaceManifestInfo[]> {
  const rootDir = folder.uri.fsPath;
  const manifestPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return [];

  const manifests = new Map<string, WorkspaceManifestInfo>();
  const rootManifest = readWorkspaceManifestInfo(rootDir, manifestPath);
  manifests.set(manifestPath, rootManifest);

  let parsedRoot;
  try {
    parsedRoot = parsePackageManifest(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return Array.from(manifests.values());
  }

  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];
  for (const pattern of parsedRoot.workspaces) {
    if (!pattern) continue;
    if (pattern.startsWith('!')) {
      excludePatterns.push(workspacePatternToManifestGlob(pattern.slice(1)));
    } else {
      includePatterns.push(workspacePatternToManifestGlob(pattern));
    }
  }

  for (const pattern of includePatterns) {
    const matched = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, pattern),
      '**/node_modules/**',
    );
    for (const uri of matched) {
      manifests.set(uri.fsPath, readWorkspaceManifestInfo(rootDir, uri.fsPath));
    }
  }

  if (excludePatterns.length > 0) {
    for (const pattern of excludePatterns) {
      const matched = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, pattern),
        '**/node_modules/**',
      );
      for (const uri of matched) {
        manifests.delete(uri.fsPath);
      }
    }
    manifests.set(manifestPath, rootManifest);
  }

  return Array.from(manifests.values()).sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
}

function readWorkspaceManifestInfo(rootDir: string, manifestPath: string): WorkspaceManifestInfo {
  let packageName: string | undefined;
  try {
    const parsed = parsePackageManifest(fs.readFileSync(manifestPath, 'utf8'));
    packageName = parsed.name;
  } catch {
    packageName = undefined;
  }

  return { rootDir, manifestPath, packageName };
}

function buildWorkspacePackageMap(manifests: WorkspaceManifestInfo[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const manifest of manifests) {
    if (manifest.packageName) {
      result.set(manifest.packageName, path.dirname(manifest.manifestPath));
    }
  }
  return result;
}

function loadLockContext(rootDir: string): LockContext {
  const packageLockPath = path.join(rootDir, 'package-lock.json');
  if (fs.existsSync(packageLockPath)) {
    try {
      return {
        kind: 'package-lock',
        packageLock: parsePackageLock(fs.readFileSync(packageLockPath, 'utf8')),
      };
    } catch {
      return {};
    }
  }

  const shrinkwrapPath = path.join(rootDir, 'npm-shrinkwrap.json');
  if (fs.existsSync(shrinkwrapPath)) {
    try {
      return {
        kind: 'npm-shrinkwrap',
        packageLock: parsePackageLock(fs.readFileSync(shrinkwrapPath, 'utf8')),
      };
    } catch {
      return {};
    }
  }

  const pnpmLockPath = path.join(rootDir, 'pnpm-lock.yaml');
  if (fs.existsSync(pnpmLockPath)) {
    try {
      return {
        kind: 'pnpm',
        pnpmLock: parsePnpmLock(fs.readFileSync(pnpmLockPath, 'utf8')),
      };
    } catch {
      return {};
    }
  }

  const yarnLockPath = path.join(rootDir, 'yarn.lock');
  if (fs.existsSync(yarnLockPath)) {
    try {
      return {
        kind: 'yarn',
        yarnLock: parseYarnLock(fs.readFileSync(yarnLockPath, 'utf8')),
      };
    } catch {
      return {};
    }
  }

  return {};
}

function resolveLocalSpecifier(
  specifier: string,
  manifestDir: string,
  workspaceByName: Map<string, string>,
  workspaceRoots: string[],
  packageName: string,
): { localDir?: string; workspaceLocal: boolean } | undefined {
  if (specifier.startsWith('workspace:')) {
    const workspaceDir = workspaceByName.get(packageName);
    if (workspaceDir) {
      return { localDir: workspaceDir, workspaceLocal: true };
    }
    return { localDir: undefined, workspaceLocal: false };
  }

  if (specifier.startsWith('file:') || specifier.startsWith('link:')) {
    const rawTarget = specifier.replace(/^(file:|link:)/, '');
    const resolvedPath = path.resolve(manifestDir, rawTarget);
    if (!fs.existsSync(resolvedPath)) {
      return { localDir: undefined, workspaceLocal: false };
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return { localDir: undefined, workspaceLocal: false };
    }
    const workspaceLocal = workspaceRoots.some(root =>
      resolvedPath === root || resolvedPath.startsWith(root + path.sep),
    );
    return { localDir: resolvedPath, workspaceLocal };
  }

  const workspaceDir = workspaceByName.get(packageName);
  if (workspaceDir && specifier === '*') {
    return { localDir: workspaceDir, workspaceLocal: true };
  }

  return undefined;
}

function resolveLockVersion(
  lockContext: LockContext,
  importerPath: string,
  packageName: string,
  specifier: string,
): string | undefined {
  if (lockContext.kind === 'package-lock' || lockContext.kind === 'npm-shrinkwrap') {
    return resolvePackageLockVersion(lockContext.packageLock, importerPath, packageName);
  }
  if (lockContext.kind === 'pnpm') {
    return resolvePnpmLockVersion(lockContext.pnpmLock, importerPath, packageName);
  }
  if (lockContext.kind === 'yarn') {
    return resolveYarnLockVersion(lockContext.yarnLock, packageName, specifier);
  }
  return undefined;
}

function mergeDependency(seen: Map<string, ResolvedDependency>, dep: ResolvedDependency): void {
  const normalizedDir = dep.localDir ?? '';
  const key = [
    dep.ecosystem,
    dep.name,
    dep.version,
    normalizedDir,
    dep.workspaceLocal ? 'workspace' : '',
  ].join('\u0000');

  const existing = seen.get(key);
  if (!existing) {
    seen.set(key, dep);
    return;
  }

  existing.sourceManifests = uniquePush(existing.sourceManifests, dep.sourceManifests);
  existing.dependencyTypes = uniquePush(existing.dependencyTypes, dep.dependencyTypes);
  existing.specifiers = uniquePush(existing.specifiers ?? [], dep.specifiers ?? []);
  existing.workspaceLocal = existing.workspaceLocal || dep.workspaceLocal;
}

function uniquePush<T>(base: T[], extra: T[]): T[] {
  const result = base.slice();
  for (const value of extra) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function normalizeImporterPath(importerPath: string): string {
  const normalized = importerPath.replace(/\\/g, '/');
  if (!normalized || normalized === '.') return '.';
  return normalized.replace(/^\.\/+/, '').replace(/\/$/, '');
}
