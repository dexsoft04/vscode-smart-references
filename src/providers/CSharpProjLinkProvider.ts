import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  getNuGetCachePath,
  resolveNuGetPackageDir,
  resolveUnityPackageDir,
  findCsEntryFile,
} from '../core/CSharpUtils';

// ── .csproj PackageReference Document Link Provider ──────────────────────────
// Makes <PackageReference Include="X" Version="Y" /> clickable, jumping to
// the package source in NuGet cache or Unity Library/PackageCache.

const PKG_REF_RE = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/gi;

export class CSharpProjLinkProvider implements vscode.DocumentLinkProvider, vscode.Disposable {
  private readonly log: vscode.OutputChannel;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const nugetCache = getNuGetCachePath();
    const wsRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? '';

    const lines = document.getText().split('\n');
    const links: vscode.DocumentLink[] = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (token.isCancellationRequested) break;
      const line = lines[lineIdx];

      const re = new RegExp(PKG_REF_RE.source, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const pkgName = m[1];
        const version = m[2];

        const pkgDir = resolvePkgDir(wsRoot, nugetCache, pkgName, version);
        if (!pkgDir) continue;

        const csFile = findCsEntryFile(pkgDir);
        const readme = path.join(pkgDir, 'README.md');
        const targetPath = csFile ?? (fs.existsSync(readme) ? readme : undefined);
        if (!targetPath) continue;

        const includeIdx = line.indexOf(`Include="${pkgName}"`, m.index);
        if (includeIdx === -1) continue;
        const nameStart = includeIdx + 'Include="'.length;

        const range = new vscode.Range(
          new vscode.Position(lineIdx, nameStart),
          new vscode.Position(lineIdx, nameStart + pkgName.length),
        );
        const link = new vscode.DocumentLink(range, vscode.Uri.file(targetPath));
        link.tooltip = `Open: ${pkgName}${version ? ` v${version}` : ''}`;
        links.push(link);
      }
    }

    this.log.appendLine(`[csproj] ${vscode.workspace.asRelativePath(document.uri)}: ${links.length} links`);
    return links;
  }

  dispose(): void { /* nothing to clean up */ }
}

function resolvePkgDir(
  wsRoot: string,
  nugetCache: string | undefined,
  name: string,
  version?: string,
): string | undefined {
  return (
    resolveUnityPackageDir(wsRoot, name, version) ??
    (nugetCache ? resolveNuGetPackageDir(nugetCache, name, version) : undefined)
  );
}
