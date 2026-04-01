import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { DependencyResolver, ResolvedDependency } from './DependencyResolver';

// ── PythonDependencyResolver ──────────────────────────────────────────────────

export class PythonDependencyResolver implements DependencyResolver {
  readonly id = 'python' as const;
  readonly displayName = 'Python';
  readonly watchPatterns = [
    '**/requirements.txt',
    '**/pyproject.toml',
    '**/setup.py',
    '**/setup.cfg',
    '**/Pipfile',
  ];

  private sitePackagesCache: string[] | undefined;

  async detect(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return false;
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      if (
        fs.existsSync(path.join(root, 'requirements.txt')) ||
        fs.existsSync(path.join(root, 'pyproject.toml')) ||
        fs.existsSync(path.join(root, 'setup.py')) ||
        fs.existsSync(path.join(root, 'setup.cfg')) ||
        fs.existsSync(path.join(root, 'Pipfile'))
      ) {
        return true;
      }
    }
    return false;
  }

  async resolve(): Promise<ResolvedDependency[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    const siteDirs = await this.getSitePackagesDirs();
    const seen = new Map<string, ResolvedDependency>();

    for (const folder of folders) {
      const root = folder.uri.fsPath;
      const rawDeps = collectDependencies(root);

      for (const dep of rawDeps) {
        if (seen.has(dep.name)) continue;
        const localDir = resolvePackageDir(siteDirs, dep.name);
        seen.set(dep.name, {
          ecosystem: 'python',
          name: dep.name,
          version: dep.version ?? '*',
          localDir,
          dependencyTypes: [dep.indirect ? 'indirect' : 'direct'],
          sourceManifests: dep.sourceManifest ? [dep.sourceManifest] : [],
        });
      }
    }

    return Array.from(seen.values());
  }

  private async getSitePackagesDirs(): Promise<string[]> {
    if (this.sitePackagesCache) return this.sitePackagesCache;

    const dirs: string[] = [];

    // 1. Ask the active Python interpreter
    const fromPython = await queryPythonSitePackages();
    dirs.push(...fromPython);

    // 2. Scan for virtual environments in workspace roots
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      dirs.push(...findVenvSitePackages(folder.uri.fsPath));
    }

    // 3. Common user site-packages fallback
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    for (const candidate of commonSitePackagePaths(home)) {
      if (fs.existsSync(candidate) && !dirs.includes(candidate)) {
        dirs.push(candidate);
      }
    }

    this.sitePackagesCache = dirs.filter(d => fs.existsSync(d));
    return this.sitePackagesCache;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface RawDep {
  name: string;
  version?: string;
  indirect?: boolean;
  sourceManifest?: string;
}

/** Collect dependencies from all manifest files in the workspace root. */
function collectDependencies(wsRoot: string): RawDep[] {
  const deps: RawDep[] = [];

  // requirements.txt
  const reqFile = path.join(wsRoot, 'requirements.txt');
  if (fs.existsSync(reqFile)) {
    deps.push(...parseRequirementsTxt(reqFile));
  }

  // pyproject.toml
  const pyprojectFile = path.join(wsRoot, 'pyproject.toml');
  if (fs.existsSync(pyprojectFile)) {
    deps.push(...parsePyprojectToml(fs.readFileSync(pyprojectFile, 'utf8'), pyprojectFile));
  }

  // setup.cfg
  const setupCfgFile = path.join(wsRoot, 'setup.cfg');
  if (fs.existsSync(setupCfgFile)) {
    deps.push(...parseSetupCfg(fs.readFileSync(setupCfgFile, 'utf8'), setupCfgFile));
  }

  return deps;
}

function parseRequirementsTxt(filePath: string): RawDep[] {
  const deps: RawDep[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return deps;
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;

    // Strip extras, environment markers, and options
    const nameVersion = line.split(/[;[\s]/)[0];
    const match = nameVersion.match(/^([A-Za-z0-9][\w.-]*)(?:[>=<!~^]+(.+))?$/);
    if (match) {
      deps.push({ name: normalizePackageName(match[1]), version: match[2], sourceManifest: filePath });
    }
  }
  return deps;
}

function parsePyprojectToml(content: string, sourceManifest: string): RawDep[] {
  const deps: RawDep[] = [];
  // Match dependencies in [project] section and [tool.poetry.dependencies]
  const depsSection = /^\[(?:project|tool\.poetry\.dependencies)\]/m;
  const lines = content.split('\n');
  let inDeps = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inDeps = depsSection.test(trimmed);
      continue;
    }
    if (!inDeps) continue;

    // [project] style: dependencies = ["requests>=2.0", "numpy"]
    const listMatch = trimmed.match(/^dependencies\s*=\s*\[/);
    if (listMatch) continue;

    // Item inside the list: "requests>=2.0"
    const itemMatch = trimmed.match(/^"([A-Za-z0-9][\w.-]*)(?:[>=<!~^[\s].*)?"/);
    if (itemMatch) {
      deps.push({ name: normalizePackageName(itemMatch[1]), sourceManifest });
      continue;
    }

    // [tool.poetry.dependencies] style: requests = "^2.0"
    const kvMatch = trimmed.match(/^([A-Za-z0-9][\w.-]*)\s*=/);
    if (kvMatch && kvMatch[1] !== 'python') {
      deps.push({ name: normalizePackageName(kvMatch[1]), sourceManifest });
    }
  }
  return deps;
}

function parseSetupCfg(content: string, sourceManifest: string): RawDep[] {
  const deps: RawDep[] = [];
  let inInstallRequires = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) { inInstallRequires = false; continue; }
    if (line.startsWith('install_requires')) { inInstallRequires = true; continue; }
    if (!inInstallRequires || !line || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z0-9][\w.-]*)(?:[>=<!~^[\s].*)?$/);
    if (match) {
      deps.push({ name: normalizePackageName(match[1]), sourceManifest });
    }
  }
  return deps;
}

/** pip normalises package names: lowercase, replace [-_.] with '-' */
function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Resolve a package name to its directory in one of the site-packages dirs.
 * Tries the package name directly, then common naming variations.
 */
export function resolvePackageDir(siteDirs: string[], pkgName: string): string | undefined {
  const normalized = normalizePackageName(pkgName);
  // Variants: normalized, underscore version, original capitalisation
  const variants = [
    normalized,
    normalized.replace(/-/g, '_'),
    pkgName,
    pkgName.replace(/-/g, '_'),
  ];

  for (const siteDir of siteDirs) {
    for (const variant of variants) {
      const candidate = path.join(siteDir, variant);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
      // Single-file modules: numpy.py etc.
      const pyFile = candidate + '.py';
      if (fs.existsSync(pyFile)) {
        return siteDir; // link to site-packages root for single-file modules
      }
    }
  }
  return undefined;
}

/** Ask the Python interpreter in PATH for its site-packages directories. */
function queryPythonSitePackages(): Promise<string[]> {
  return new Promise(resolve => {
    const cmd = 'python3 -c "import site,json;dirs=getattr(site,\'getsitepackages\',lambda:[])();u=site.getusersitepackages();print(json.dumps(list(set(dirs+[u]))))"';
    exec(cmd, { encoding: 'utf8' }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/** Scan workspace root for common venv/virtualenv layouts. */
function findVenvSitePackages(wsRoot: string): string[] {
  const result: string[] = [];
  const venvNames = ['venv', '.venv', 'env', '.env', '.python-version'];
  for (const name of venvNames) {
    const venvRoot = path.join(wsRoot, name);
    if (!fs.existsSync(venvRoot)) continue;
    // lib/pythonX.Y/site-packages
    const libDir = path.join(venvRoot, 'lib');
    if (!fs.existsSync(libDir)) continue;
    try {
      const pyDirs = fs.readdirSync(libDir).filter(d => /^python\d/.test(d));
      for (const pyDir of pyDirs) {
        const sp = path.join(libDir, pyDir, 'site-packages');
        if (fs.existsSync(sp)) result.push(sp);
      }
    } catch { /* ignore */ }
  }
  return result;
}

/** Common site-packages paths as a last-resort fallback. */
function commonSitePackagePaths(home: string): string[] {
  const candidates: string[] = [];
  // User site-packages for Python 3.x
  for (const minor of ['13', '12', '11', '10', '9', '8']) {
    const version = `3.${minor}`;
    candidates.push(
      path.join(home, '.local', 'lib', `python${version}`, 'site-packages'),
      `/usr/lib/python${version}/site-packages`,
      `/usr/local/lib/python${version}/site-packages`,
      `/usr/lib/python3/dist-packages`,
    );
  }
  return candidates;
}
