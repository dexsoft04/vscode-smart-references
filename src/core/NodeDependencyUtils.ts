import * as fs from 'fs';
import * as path from 'path';
import type { DependencyType } from './DependencyResolver';

export interface RawNodeDependency {
  name: string;
  specifier: string;
  dependencyType: DependencyType;
}

export interface ParsedPackageManifest {
  name?: string;
  workspaces: string[];
  dependencies: RawNodeDependency[];
}

export interface PackageLockData {
  importerVersions: Map<string, Map<string, string>>;
}

export interface PnpmLockData {
  importerVersions: Map<string, Map<string, string>>;
}

export interface YarnLockData {
  selectorVersions: Map<string, string>;
}

type PackageLockEntry = {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

export function parsePackageManifest(content: string): ParsedPackageManifest {
  const manifest = JSON.parse(content) as {
    name?: string;
    workspaces?: string[] | { packages?: string[] };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  const dependencies: RawNodeDependency[] = [];
  pushSectionDependencies(dependencies, manifest.dependencies, 'direct');
  pushSectionDependencies(dependencies, manifest.devDependencies, 'dev');
  pushSectionDependencies(dependencies, manifest.peerDependencies, 'peer');
  pushSectionDependencies(dependencies, manifest.optionalDependencies, 'optional');

  let workspaces: string[] = [];
  if (Array.isArray(manifest.workspaces)) {
    workspaces = manifest.workspaces.slice();
  } else if (manifest.workspaces?.packages && Array.isArray(manifest.workspaces.packages)) {
    workspaces = manifest.workspaces.packages.slice();
  }

  return {
    name: manifest.name,
    workspaces,
    dependencies,
  };
}

export function workspacePatternToManifestGlob(pattern: string): string {
  let normalized = pattern.replace(/\\/g, '/').trim();
  if (!normalized) return 'package.json';
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  if (normalized.endsWith('package.json')) return normalized;
  return `${normalized}/package.json`;
}

export function resolveNodePackageDir(startDir: string, packageName: string): string | undefined {
  const packageSegments = packageName.split('/');
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, 'node_modules', ...packageSegments);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return undefined;
}

export function readNodePackageVersion(packageDir: string): string | undefined {
  const packageJsonPath = path.join(packageDir, 'package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return manifest.version;
  } catch {
    return undefined;
  }
}

export function isNodeModulesPath(fsPath: string): boolean {
  return fsPath.includes(NODE_MODULES_SEGMENT) || fsPath.endsWith(`${path.sep}node_modules`);
}

export function parsePackageLock(content: string): PackageLockData {
  const importerVersions = new Map<string, Map<string, string>>();

  try {
    const parsed = JSON.parse(content) as {
      packages?: Record<string, PackageLockEntry>;
      dependencies?: Record<string, { version?: string }>;
    };

    const packages = parsed.packages;
    if (packages) {
      for (const [pkgKey, entry] of Object.entries(packages)) {
        if (pkgKey.includes('node_modules')) continue;
        const importerPath = pkgKey || '.';
        const versionMap = new Map<string, string>();

        for (const depName of Object.keys(entry.dependencies ?? {})) {
          const version = findPackageLockDependencyVersion(packages, pkgKey, depName);
          if (version) versionMap.set(depName, version);
        }
        for (const depName of Object.keys(entry.devDependencies ?? {})) {
          const version = findPackageLockDependencyVersion(packages, pkgKey, depName);
          if (version) versionMap.set(depName, version);
        }
        for (const depName of Object.keys(entry.peerDependencies ?? {})) {
          const version = findPackageLockDependencyVersion(packages, pkgKey, depName);
          if (version) versionMap.set(depName, version);
        }
        for (const depName of Object.keys(entry.optionalDependencies ?? {})) {
          const version = findPackageLockDependencyVersion(packages, pkgKey, depName);
          if (version) versionMap.set(depName, version);
        }

        importerVersions.set(normalizeImporterPath(importerPath), versionMap);
      }
    }

    if (importerVersions.size === 0 && parsed.dependencies) {
      const rootVersions = new Map<string, string>();
      for (const [depName, depEntry] of Object.entries(parsed.dependencies)) {
        if (depEntry?.version) rootVersions.set(depName, depEntry.version);
      }
      importerVersions.set('.', rootVersions);
    }
  } catch {
    return { importerVersions: new Map() };
  }

  return { importerVersions };
}

export function parsePnpmLock(content: string): PnpmLockData {
  const importerVersions = new Map<string, Map<string, string>>();

  let inImporters = false;
  let currentImporter: string | undefined;
  let currentDepType: string | undefined;
  let currentDepName: string | undefined;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    if (!inImporters) {
      if (line.trim() === 'importers:') {
        inImporters = true;
      }
      continue;
    }

    if (!line.startsWith(' ')) {
      break;
    }

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (indent === 2 && trimmed.endsWith(':')) {
      currentImporter = normalizeImporterPath(stripYamlKey(trimmed.slice(0, -1)));
      if (!importerVersions.has(currentImporter)) {
        importerVersions.set(currentImporter, new Map());
      }
      currentDepType = undefined;
      currentDepName = undefined;
      continue;
    }

    if (!currentImporter) continue;

    const depTypeMatch = indent === 4
      ? trimmed.match(/^(dependencies|devDependencies|peerDependencies|optionalDependencies):$/)
      : null;
    if (depTypeMatch) {
      currentDepType = depTypeMatch[1];
      currentDepName = undefined;
      continue;
    }

    if (!currentDepType) continue;

    const shorthandMatch = indent === 6 ? trimmed.match(/^(.+?):\s+(.+?)\s*$/) : null;
    if (shorthandMatch && !trimmed.endsWith(':')) {
      importerVersions.get(currentImporter)?.set(stripYamlKey(shorthandMatch[1]), stripYamlValue(shorthandMatch[2]));
      currentDepName = undefined;
      continue;
    }

    const depNameMatch = indent === 6 ? trimmed.match(/^(.+):$/) : null;
    if (depNameMatch) {
      currentDepName = stripYamlKey(depNameMatch[1]);
      continue;
    }

    if (!currentDepName) continue;

    const versionMatch = indent === 8 ? trimmed.match(/^version:\s+(.+?)\s*$/) : null;
    if (versionMatch) {
      importerVersions.get(currentImporter)?.set(currentDepName, stripYamlValue(versionMatch[1]));
    }
  }

  return { importerVersions };
}

export function parseYarnLock(content: string): YarnLockData {
  const selectorVersions = new Map<string, string>();

  let currentSelectors: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    if (!line.startsWith(' ')) {
      if (!line.endsWith(':')) {
        currentSelectors = [];
        continue;
      }
      currentSelectors = parseYarnSelectors(line.slice(0, -1));
      continue;
    }

    const versionMatch = line.match(/^ {2}version\s+"?([^"\n]+)"?\s*$/);
    if (versionMatch) {
      const version = versionMatch[1];
      for (const selector of currentSelectors) {
        selectorVersions.set(selector, version);
      }
    }
  }

  return { selectorVersions };
}

export function resolvePackageLockVersion(
  data: PackageLockData | undefined,
  importerPath: string,
  depName: string,
): string | undefined {
  if (!data) return undefined;
  const normalizedImporter = normalizeImporterPath(importerPath);
  return (
    data.importerVersions.get(normalizedImporter)?.get(depName) ??
    data.importerVersions.get('.')?.get(depName)
  );
}

export function resolvePnpmLockVersion(
  data: PnpmLockData | undefined,
  importerPath: string,
  depName: string,
): string | undefined {
  if (!data) return undefined;
  const normalizedImporter = normalizeImporterPath(importerPath);
  return (
    data.importerVersions.get(normalizedImporter)?.get(depName) ??
    data.importerVersions.get('.')?.get(depName)
  );
}

export function resolveYarnLockVersion(
  data: YarnLockData | undefined,
  depName: string,
  specifier: string,
): string | undefined {
  if (!data) return undefined;

  const candidates = [
    `${depName}@${specifier}`,
    `"${depName}@${specifier}"`,
    `${depName}@npm:${specifier}`,
  ];

  for (const candidate of candidates) {
    const version = data.selectorVersions.get(candidate);
    if (version) return version;
  }

  for (const [selector, version] of data.selectorVersions.entries()) {
    if (selector.startsWith(`${depName}@`)) return version;
  }

  return undefined;
}

function pushSectionDependencies(
  out: RawNodeDependency[],
  deps: Record<string, string> | undefined,
  dependencyType: DependencyType,
): void {
  if (!deps) return;
  for (const [name, specifier] of Object.entries(deps)) {
    out.push({ name, specifier, dependencyType });
  }
}

function findPackageLockDependencyVersion(
  packages: Record<string, PackageLockEntry>,
  importerKey: string,
  depName: string,
): string | undefined {
  const exactKeys = [
    importerKey ? `${importerKey}/node_modules/${depName}` : `node_modules/${depName}`,
    `node_modules/${depName}`,
  ];

  for (const key of exactKeys) {
    const version = packages[key]?.version;
    if (version) return version;
  }

  let fallbackVersion: string | undefined;
  let fallbackKey: string | undefined;
  const suffix = `/node_modules/${depName}`;
  for (const [key, entry] of Object.entries(packages)) {
    if (!key.endsWith(suffix) && key !== `node_modules/${depName}`) continue;
    if (!fallbackKey || key.length < fallbackKey.length) {
      fallbackKey = key;
      fallbackVersion = entry.version;
    }
  }

  return fallbackVersion;
}

function parseYarnSelectors(raw: string): string[] {
  const selectors: string[] = [];
  const re = /"([^"]+)"|([^,]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const selector = (match[1] ?? match[2] ?? '').trim();
    if (selector) selectors.push(selector);
  }
  return selectors;
}

function stripYamlKey(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function stripYamlValue(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

function normalizeImporterPath(importerPath: string): string {
  const normalized = importerPath.replace(/\\/g, '/');
  if (!normalized || normalized === '.') return '.';
  return normalized.replace(/^\.\/+/, '').replace(/\/$/, '');
}
