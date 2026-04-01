import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

// ── go.mod Document Link Provider ────────────────────────────────────────────
// The link is placed on the VERSION string (e.g. "v1.2.3"), not the module
// name, because gopls already places a link on the module name pointing to
// pkg.go.dev.  Placing our link on the version avoids range conflicts.

export class GoModLinkProvider implements vscode.DocumentLinkProvider, vscode.Disposable {
  private goModCache: string | undefined;
  private readonly log: vscode.OutputChannel;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const goModCache = await this.resolveGoModCache();
    if (!goModCache || token.isCancellationRequested) return [];

    this.log.appendLine(`[go.mod] scanning ${vscode.workspace.asRelativePath(document.uri)}, GOMODCACHE=${goModCache}`);

    const text = document.getText();
    const lines = text.split('\n');

    // Parse replace directives: original => replacement version
    const replaces = parseReplaceDirectives(text);

    const links: vscode.DocumentLink[] = [];

    const requireLineRe  = /^\t([\w.@/-]+)\s+(v[\w.+-]+)/;
    const requireInlineRe = /^([\w.@/-]+)\s+(v[\w.+-]+)/;

    let inRequireBlock = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (token.isCancellationRequested) break;
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (trimmed === 'require (' || trimmed === 'require(') { inRequireBlock = true; continue; }
      if (inRequireBlock && trimmed === ')') { inRequireBlock = false; continue; }
      if (trimmed.startsWith('//')) continue;

      let match: RegExpMatchArray | null = null;

      if (inRequireBlock) {
        match = line.match(requireLineRe);
      } else if (trimmed.startsWith('require ') && !trimmed.includes('(')) {
        match = trimmed.slice('require '.length).match(requireInlineRe);
      }

      if (!match) continue;

      const modulePath = match[1];
      const version    = match[2];

      // Apply replace directive if present
      const rep = replaces.get(modulePath);
      const lookupPath    = rep ? rep.name    : modulePath;
      const lookupVersion = rep ? rep.version : version;

      const localDir = resolveModuleDir(goModCache, lookupPath, lookupVersion);
      if (!localDir) {
        this.log.appendLine(`[go.mod]   miss: ${modulePath}@${version} (not in cache)`);
        continue;
      }

      const targetUri = buildTargetUri(localDir);
      if (!targetUri) {
        this.log.appendLine(`[go.mod]   miss: ${modulePath}@${version} (no .go files)`);
        continue;
      }

      // Place link on the VERSION string to avoid conflict with gopls's link on the module name
      const versionStart = line.indexOf(version, line.indexOf(modulePath) + modulePath.length);
      if (versionStart === -1) continue;

      const range = new vscode.Range(
        new vscode.Position(lineIdx, versionStart),
        new vscode.Position(lineIdx, versionStart + version.length),
      );

      const link = new vscode.DocumentLink(range, targetUri);
      link.tooltip = `Open in editor: ${path.relative(goModCache, localDir)}`;
      links.push(link);
      this.log.appendLine(`[go.mod]   link: ${modulePath}@${version} → ${targetUri.fsPath}`);
    }

    this.log.appendLine(`[go.mod] total links: ${links.length}`);
    return links;
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

  dispose(): void { /* nothing to clean up */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse all replace directives from go.mod text.
 * Supports both block form (replace ( ... )) and single-line form.
 * Returns a map: original module path → { name, version } of replacement.
 * Local path replacements (no version on the right side) are ignored.
 */
function parseReplaceDirectives(text: string): Map<string, { name: string; version: string }> {
  const result = new Map<string, { name: string; version: string }>();
  // replace <orig> [<origver>] => <newmod> <newver>
  const replaceRe = /^([\w.@/-]+)(?:\s+v[\w.+-]+)?\s+=>\s+([\w.@/-]+)\s+(v[\w.+-]+)/;

  let inBlock = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    if (trimmed === 'replace (' || trimmed === 'replace(') { inBlock = true; continue; }
    if (inBlock && trimmed === ')') { inBlock = false; continue; }

    let candidate = '';
    if (inBlock) {
      candidate = trimmed;
    } else if (trimmed.startsWith('replace ') && !trimmed.includes('(')) {
      candidate = trimmed.slice('replace '.length);
    }

    if (!candidate) continue;
    const m = candidate.match(replaceRe);
    if (m) result.set(m[1], { name: m[2], version: m[3] });
  }
  return result;
}

/**
 * Go module cache encodes uppercase letters as `!lowercase` in directory names.
 * e.g. "github.com/BurntSushi/toml" → "github.com/!burnt!sushi/toml"
 */
function encodeModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`);
}

function resolveModuleDir(goModCache: string, modulePath: string, version: string): string | undefined {
  const encoded = encodeModulePath(modulePath);
  const dir = path.join(goModCache, `${encoded}@${version}`);
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * Finds the best entry-point .go file in the module root directory.
 * Preference: doc.go > shortest non-test .go file
 */
function buildTargetUri(moduleDir: string): vscode.Uri | undefined {
  try {
    const entries = fs.readdirSync(moduleDir);
    const goFiles = entries.filter(f => f.endsWith('.go') && !f.endsWith('_test.go'));
    if (goFiles.length > 0) {
      const preferred = goFiles.find(f => f === 'doc.go')
        ?? goFiles.sort((a, b) => a.length - b.length)[0];
      return vscode.Uri.file(path.join(moduleDir, preferred));
    }
    return undefined;
  } catch {
    return undefined;
  }
}
