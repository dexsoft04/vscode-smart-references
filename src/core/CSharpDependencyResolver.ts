import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DependencyResolver, ResolvedDependency } from './DependencyResolver';
import { getNuGetCachePath, resolveNuGetPackageDir, resolveUnityPackageDir } from './CSharpUtils';

// ── CSharpDependencyResolver ─────────────────────────────────────────────────

export class CSharpDependencyResolver implements DependencyResolver {
  readonly id = 'csharp' as const;
  readonly displayName = 'C#';
  readonly watchPatterns = ['**/*.csproj', '**/Packages/manifest.json'];

  async detect(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return false;
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      // Check for .csproj files
      const csprojFiles = await findFilesByGlob(folder, '**/*.csproj');
      if (csprojFiles.length > 0) return true;
      // Check for Unity project (Packages/manifest.json)
      if (fs.existsSync(path.join(root, 'Packages', 'manifest.json'))) return true;
    }
    return false;
  }

  async resolve(): Promise<ResolvedDependency[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    const seen = new Map<string, ResolvedDependency>();

    for (const folder of folders) {
      const root = folder.uri.fsPath;

      // 1. Parse .csproj PackageReference
      const csprojFiles = await findFilesByGlob(folder, '**/*.csproj');
      for (const uri of csprojFiles) {
        const deps = parseCsproj(fs.readFileSync(uri.fsPath, 'utf8'));
        for (const dep of deps) {
          if (!seen.has(dep.name)) {
            const localDir = this.resolvePackageDir(root, dep.name, dep.version);
            seen.set(dep.name, {
              ecosystem: 'csharp',
              name: dep.name,
              version: dep.version,
              localDir,
              dependencyTypes: ['direct'],
              sourceManifests: [uri.fsPath],
            });
          }
        }
      }

      // 2. Parse Unity Packages/manifest.json
      const manifestPath = path.join(root, 'Packages', 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const deps = parseUnityManifest(fs.readFileSync(manifestPath, 'utf8'));
        for (const dep of deps) {
          if (!seen.has(dep.name)) {
            const localDir = resolveUnityPackageDir(root, dep.name, dep.version);
            seen.set(dep.name, {
              ecosystem: 'csharp',
              name: dep.name,
              version: dep.version,
              localDir,
              dependencyTypes: ['direct'],
              sourceManifests: [manifestPath],
            });
          }
        }
      }
    }

    return Array.from(seen.values());
  }

  private resolvePackageDir(wsRoot: string, name: string, version: string): string | undefined {
    const nugetCache = getNuGetCachePath();
    return (
      resolveUnityPackageDir(wsRoot, name, version) ??
      (nugetCache ? resolveNuGetPackageDir(nugetCache, name, version) : undefined)
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findFilesByGlob(
  folder: vscode.WorkspaceFolder,
  glob: string,
): Promise<vscode.Uri[]> {
  return vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, glob),
    '**/node_modules/**',
    50,
  );
}

interface RawDep { name: string; version: string }

function parseCsproj(content: string): RawDep[] {
  const deps: RawDep[] = [];
  // Match <PackageReference Include="X" Version="Y" />
  const re = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    deps.push({ name: m[1], version: m[2] ?? '*' });
  }
  return deps;
}

function parseUnityManifest(content: string): RawDep[] {
  try {
    const manifest = JSON.parse(content) as { dependencies?: Record<string, string> };
    if (!manifest.dependencies) return [];
    return Object.entries(manifest.dependencies).map(([name, version]) => ({
      name,
      version: version.replace(/^file:.*/, 'local'),
    }));
  } catch {
    return [];
  }
}
