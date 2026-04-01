import * as path from 'path';
import * as fs from 'fs';

// ── Shared C# / NuGet utilities ───────────────────────────────────────────────

/** Returns the NuGet global-packages cache directory, or undefined if absent. */
export function getNuGetCachePath(): string | undefined {
  const fromEnv = process.env.NUGET_PACKAGES;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const fallback = path.join(home, '.nuget', 'packages');
  if (fs.existsSync(fallback)) return fallback;

  return undefined;
}

/**
 * Resolve a NuGet package to its local cache directory.
 * Tries the exact version first, then picks the newest available version.
 */
export function resolveNuGetPackageDir(
  nugetCache: string,
  name: string,
  version?: string,
): string | undefined {
  const pkgRoot = path.join(nugetCache, name.toLowerCase());
  if (!fs.existsSync(pkgRoot)) return undefined;

  if (version) {
    const exact = path.join(pkgRoot, version);
    if (fs.existsSync(exact)) return exact;
  }

  try {
    const versions = fs.readdirSync(pkgRoot)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .reverse();
    if (versions.length > 0) return path.join(pkgRoot, versions[0]);
  } catch { /* ignore */ }

  return undefined;
}

/**
 * Resolve a Unity package to its local cache directory.
 * Searches Library/PackageCache and Packages/ (local packages).
 */
export function resolveUnityPackageDir(
  wsRoot: string,
  name: string,
  version?: string,
): string | undefined {
  // Library/PackageCache/<name>@<version>/
  const pkgCacheDir = path.join(wsRoot, 'Library', 'PackageCache');
  if (fs.existsSync(pkgCacheDir)) {
    try {
      const entries = fs.readdirSync(pkgCacheDir);
      if (version) {
        const exact = entries.find(e => e === `${name}@${version}`);
        if (exact) return path.join(pkgCacheDir, exact);
      }
      const prefix = entries.find(e => e.startsWith(`${name}@`));
      if (prefix) return path.join(pkgCacheDir, prefix);
    } catch { /* ignore */ }
  }

  // Packages/<name>/ (local packages)
  const localPkg = path.join(wsRoot, 'Packages', name);
  if (fs.existsSync(localPkg)) return localPkg;

  return undefined;
}

/**
 * Find a representative .cs file to open from a package directory.
 * Prefers files in a Runtime/ subdirectory, then shortest top-level .cs file.
 */
export function findCsEntryFile(pkgDir: string): string | undefined {
  // Prefer Runtime/ subdirectory (Unity package convention)
  try {
    const entries = fs.readdirSync(pkgDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase() === 'runtime') {
        const f = firstCsFile(path.join(pkgDir, entry.name));
        if (f) return f;
      }
    }
  } catch { /* ignore */ }

  return firstCsFile(pkgDir);
}

function firstCsFile(dir: string): string | undefined {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.cs') && !f.endsWith('.Designer.cs') && !f.endsWith('AssemblyInfo.cs'))
      .sort((a, b) => a.length - b.length);
    if (files.length > 0) return path.join(dir, files[0]);
  } catch { /* ignore */ }
  return undefined;
}
