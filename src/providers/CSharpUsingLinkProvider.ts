import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getNuGetCachePath, resolveNuGetPackageDir } from '../core/CSharpUtils';

// ── C# using statement Document Link Provider ───────────────────────────────
// Makes `using` directives clickable, jumping to the package source code in
// NuGet cache or Unity Library/PackageCache.

const USING_RE = /^\s*(?:global\s+)?using\s+(?:static\s+)?([A-Za-z][\w.]*)\s*;/;
const NAMESPACE_RE = /^\s*namespace\s+([\w.]+)/;

export class CSharpUsingLinkProvider implements vscode.DocumentLinkProvider, vscode.Disposable {
  private readonly log: vscode.OutputChannel;

  // Cached mapping: namespace prefix → package directory (Promise-cached to avoid concurrent builds)
  private nsToDirPromise: Promise<Map<string, string>> | undefined;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  invalidateCache(): void {
    this.nsToDirPromise = undefined;
  }

  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const nsMap = await this.getNamespaceMap();
    if (token.isCancellationRequested || nsMap.size === 0) return [];

    const text = document.getText();
    const lines = text.split('\n');
    const links: vscode.DocumentLink[] = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (token.isCancellationRequested) break;
      const line = lines[lineIdx];
      const m = line.match(USING_RE);
      if (!m) {
        // Stop only when we reach the first declaration that can't appear before using blocks:
        // namespace/class/struct/interface/enum/record/[assembly declarations
        const trimmed = line.trim();
        if (
          trimmed.startsWith('namespace ') ||
          /^(public|internal|private|protected|file)\s+(partial\s+)?(class|struct|interface|enum|record|abstract|sealed|static)\b/.test(trimmed) ||
          trimmed.startsWith('[assembly:')
        ) {
          break;
        }
        continue;
      }

      const ns = m[1];
      const dir = this.resolveNamespace(nsMap, ns);
      if (!dir) continue;

      const targetUri = buildCSharpTargetUri(dir);
      if (!targetUri) continue;

      // Place link on the namespace text
      const nsStart = line.indexOf(ns, line.indexOf('using'));
      if (nsStart === -1) continue;

      const range = new vscode.Range(
        new vscode.Position(lineIdx, nsStart),
        new vscode.Position(lineIdx, nsStart + ns.length),
      );

      const link = new vscode.DocumentLink(range, targetUri);
      link.tooltip = `Open: ${vscode.workspace.asRelativePath(targetUri) || targetUri.fsPath}`;
      links.push(link);
    }

    this.log.appendLine(`[cs-using] ${vscode.workspace.asRelativePath(document.uri)}: ${links.length} links`);
    return links;
  }

  private resolveNamespace(nsMap: Map<string, string>, ns: string): string | undefined {
    // Try exact match first, then progressively shorter prefixes
    let candidate = ns;
    while (candidate) {
      const dir = nsMap.get(candidate);
      if (dir) return dir;
      const lastDot = candidate.lastIndexOf('.');
      if (lastDot === -1) break;
      candidate = candidate.substring(0, lastDot);
    }
    return undefined;
  }

  private getNamespaceMap(): Promise<Map<string, string>> {
    if (!this.nsToDirPromise) {
      this.nsToDirPromise = this.buildNamespaceMap();
    }
    return this.nsToDirPromise;
  }

  private async buildNamespaceMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return map;

    const t0 = Date.now();

    for (const folder of folders) {
      const root = folder.uri.fsPath;

      // 1. Scan Unity Library/PackageCache
      const unityCacheDir = path.join(root, 'Library', 'PackageCache');
      if (fs.existsSync(unityCacheDir)) {
        this.scanPackageDirsForNamespaces(unityCacheDir, map);
      }

      // 2. Scan Unity Packages/ (local packages)
      const packagesDir = path.join(root, 'Packages');
      if (fs.existsSync(packagesDir)) {
        this.scanLocalPackagesForNamespaces(packagesDir, map);
      }

      // 3. Scan NuGet cache for packages referenced in .csproj
      await this.scanNuGetPackages(folder, map);
    }

    this.log.appendLine(`[cs-using] namespace map built: ${map.size} entries in ${Date.now() - t0}ms`);
    return map;
  }

  private scanPackageDirsForNamespaces(cacheDir: string, map: Map<string, string>): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(cacheDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const pkgDir = path.join(cacheDir, entry);
      try {
        if (!fs.statSync(pkgDir).isDirectory()) continue;
      } catch {
        continue;
      }
      this.extractNamespacesFromDir(pkgDir, map);
    }
  }

  private scanLocalPackagesForNamespaces(packagesDir: string, map: Map<string, string>): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(packagesDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry === 'manifest.json' || entry === 'packages-lock.json') continue;
      const pkgDir = path.join(packagesDir, entry);
      try {
        if (!fs.statSync(pkgDir).isDirectory()) continue;
      } catch {
        continue;
      }
      this.extractNamespacesFromDir(pkgDir, map);
    }
  }

  private async scanNuGetPackages(folder: vscode.WorkspaceFolder, map: Map<string, string>): Promise<void> {
    const nugetCache = getNuGetCachePath();
    if (!nugetCache) return;

    const csprojFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.csproj'),
      '**/node_modules/**',
      50,
    );

    for (const uri of csprojFiles) {
      let content: string;
      try {
        content = fs.readFileSync(uri.fsPath, 'utf8');
      } catch {
        continue;
      }

      const re = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const pkgName = m[1];
        const version = m[2];
        const pkgDir = resolveNuGetPackageDir(nugetCache, pkgName, version);
        if (pkgDir) {
          this.extractNamespacesFromDir(pkgDir, map);
        }
      }
    }
  }

/**
   * Scan .cs files in a package directory to extract namespace declarations.
   * Maps each found namespace to the package directory.
   * Only scans up to a limited number of files for performance.
   */
  private extractNamespacesFromDir(pkgDir: string, map: Map<string, string>): void {
    const csFiles = findCsFilesShallow(pkgDir, 3);
    for (const filePath of csFiles) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        const m = line.match(NAMESPACE_RE);
        if (m) {
          const ns = m[1];
          if (!map.has(ns)) {
            map.set(ns, pkgDir);
          }
        }
      }
    }
  }

  dispose(): void { /* nothing to clean up */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Find .cs files in a directory, searching up to `maxDepth` levels deep.
 * Returns at most 20 files (enough to extract representative namespaces).
 */
function findCsFilesShallow(dir: string, maxDepth: number): string[] {
  const results: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];

  while (stack.length > 0 && results.length < 20) {
    const { dir: currentDir, depth } = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory() && depth < maxDepth) {
        const lower = entry.name.toLowerCase();
        if (lower !== 'bin' && lower !== 'obj' && lower !== 'test' && lower !== 'tests') {
          stack.push({ dir: fullPath, depth: depth + 1 });
        }
      } else if (entry.name.endsWith('.cs') && !entry.name.endsWith('.Designer.cs')) {
        results.push(fullPath);
        if (results.length >= 20) break;
      }
    }
  }

  return results;
}

/**
 * Find a representative .cs file to open from a package directory.
 * Preference: file matching namespace segments > shortest .cs file > README.md
 */
function buildCSharpTargetUri(pkgDir: string): vscode.Uri | undefined {
  const csFiles = findCsFilesShallow(pkgDir, 3);

  if (csFiles.length > 0) {
    // Prefer the shortest path (likely a top-level, representative file)
    csFiles.sort((a, b) => a.length - b.length);
    return vscode.Uri.file(csFiles[0]);
  }

  // Fallback: README
  const readme = path.join(pkgDir, 'README.md');
  if (fs.existsSync(readme)) return vscode.Uri.file(readme);

  return undefined;
}
