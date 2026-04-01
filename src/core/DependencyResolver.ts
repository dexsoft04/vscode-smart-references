import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

// ── Shared types ──────────────────────────────────────────────────────────────

export type DependencyEcosystem = 'go' | 'csharp' | 'python' | 'node';
export type DependencyType = 'direct' | 'indirect' | 'dev' | 'peer' | 'optional';

export interface ResolvedDependency {
  ecosystem: DependencyEcosystem;
  name: string;             // "github.com/some/module" / "lodash"
  version: string;          // resolved version or declared range if unresolved
  localDir?: string;        // absolute path to local cache; undefined = not installed/downloaded
  dependencyTypes: DependencyType[];
  sourceManifests: string[];
  workspaceLocal?: boolean;
  specifiers?: string[];
}

export interface DependencyResolver {
  readonly id: DependencyEcosystem;
  readonly displayName: string;
  /** Return true if this resolver applies to the current workspace */
  detect(): Promise<boolean>;
  /** Parse and return the full dependency list */
  resolve(): Promise<ResolvedDependency[]>;
  /** Glob patterns for files to watch (trigger refresh on change) */
  readonly watchPatterns: string[];
}

// ── GoModResolver ─────────────────────────────────────────────────────────────

export class GoModResolver implements DependencyResolver {
  readonly id = 'go' as const;
  readonly displayName = 'Go';
  readonly watchPatterns = ['**/go.mod'];

  private goModCache: string | undefined;
  private goModPath: string | undefined;

  async detect(): Promise<boolean> {
    this.goModPath = await findGoMod();
    return this.goModPath !== undefined;
  }

  async resolve(): Promise<ResolvedDependency[]> {
    if (!this.goModPath) {
      this.goModPath = await findGoMod();
    }
    if (!this.goModPath) return [];

    const goModCache = await this.resolveGoModCache();
    if (!goModCache) return [];

    const text = fs.readFileSync(this.goModPath, 'utf8');
    const { deps, replaces } = parseGoMod(text);

    return deps.map(({ name, version, indirect }) => {
      // Apply replace directive: use the replacement module+version for cache lookup
      const rep = replaces.get(name);
      const lookupName    = rep ? rep.name    : name;
      const lookupVersion = rep ? rep.version : version;
      const localDir = resolveModuleDir(goModCache, lookupName, lookupVersion);
      return {
        ecosystem: 'go',
        name,
        version,
        localDir,
        dependencyTypes: [indirect ? 'indirect' : 'direct'],
        sourceManifests: [this.goModPath!],
      };
    });
  }

  private async resolveGoModCache(): Promise<string | undefined> {
    if (this.goModCache) return this.goModCache;

    const fromEnv = await new Promise<string | undefined>(resolve => {
      exec('go env GOMODCACHE', { encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? undefined : stdout.trim() || undefined);
      });
    });

    if (fromEnv) {
      this.goModCache = fromEnv;
      return fromEnv;
    }

    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const fallback = path.join(home, 'go', 'pkg', 'mod');
    if (fs.existsSync(fallback)) {
      this.goModCache = fallback;
      return fallback;
    }
    return undefined;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findGoMod(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return undefined;
  for (const folder of folders) {
    const candidate = path.join(folder.uri.fsPath, 'go.mod');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface RawDep { name: string; version: string; indirect: boolean; }
interface ParseResult {
  deps: RawDep[];
  replaces: Map<string, { name: string; version: string }>;
}

function parseGoMod(text: string): ParseResult {
  const deps: RawDep[] = [];
  const replaces = new Map<string, { name: string; version: string }>();

  const moduleRe  = /^([\w.@/-]+)\s+(v[\w.+-]+)/;
  const replaceRe = /^([\w.@/-]+)(?:\s+v[\w.+-]+)?\s+=>\s+([\w.@/-]+)\s+(v[\w.+-]+)/;

  type Block = 'require' | 'replace' | null;
  let inBlock: Block = null;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;

    if (trimmed === 'require (' || trimmed === 'require(') { inBlock = 'require'; continue; }
    if (trimmed === 'replace (' || trimmed === 'replace(') { inBlock = 'replace'; continue; }
    if (inBlock && trimmed === ')') { inBlock = null; continue; }

    if (inBlock === 'require') {
      const m = line.match(/^\t([\w.@/-]+)\s+(v[\w.+-]+)(.*)?$/);
      if (m) {
        deps.push({ name: m[1], version: m[2], indirect: (m[3] ?? '').includes('indirect') });
      }
      continue;
    }

    if (inBlock === 'replace') {
      const m = trimmed.match(replaceRe);
      if (m) replaces.set(m[1], { name: m[2], version: m[3] });
      continue;
    }

    // Single-line require
    if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
      const m = trimmed.slice('require '.length).match(moduleRe);
      if (m) deps.push({ name: m[1], version: m[2], indirect: trimmed.includes('// indirect') });
      continue;
    }

    // Single-line replace
    if (trimmed.startsWith('replace ') && !trimmed.includes('(')) {
      const m = trimmed.slice('replace '.length).match(replaceRe);
      if (m) replaces.set(m[1], { name: m[2], version: m[3] });
    }
  }

  return { deps, replaces };
}

/**
 * Go module cache encodes uppercase letters as `!lowercase` in directory names.
 * e.g. "github.com/BurntSushi/toml" → "github.com/!burnt!sushi/toml"
 */
export function encodeGoModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

export function resolveModuleDir(goModCache: string, modulePath: string, version: string): string | undefined {
  const encoded = encodeGoModulePath(modulePath);
  const dir = path.join(goModCache, `${encoded}@${version}`);
  return fs.existsSync(dir) ? dir : undefined;
}
