import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GoModResolver } from './DependencyResolver';
import { BaseDepSymbolIndexer } from './BaseDepSymbolIndexer';

// ── Regex patterns for exported Go declarations ───────────────────────────────

// Only exported symbols (uppercase first letter)
const FUNC_RE    = /^func\s+([A-Z]\w*)\s*\(/;           // package-level function
const METHOD_RE  = /^func\s+\([^)]+\)\s+([A-Z]\w*)\s*\(/; // method with receiver
const STRUCT_RE  = /^type\s+([A-Z]\w*)\s+struct\b/;     // struct type
const IFACE_RE   = /^type\s+([A-Z]\w*)\s+interface\b/;  // interface type
const PACKAGE_RE = /^package\s+(\w+)/;

// ── Shared interface for dependency symbol indexers ─────────────────────────

export interface DepSymbolIndexer extends vscode.Disposable {
  invalidate(): void;
  getSymbols(): Promise<vscode.SymbolInformation[]>;
}

// ── GoDepSymbolIndexer ────────────────────────────────────────────────────────

export class GoDepSymbolIndexer extends BaseDepSymbolIndexer {
  protected readonly logPrefix = 'go-dep-index';

  protected async buildIndex(): Promise<{ symbols: vscode.SymbolInformation[]; depCount?: number }> {
    const resolver = new GoModResolver();
    const applicable = await resolver.detect();
    if (!applicable) {
      this.log.appendLine(`[${this.logPrefix}] no go.mod found, index empty`);
      return { symbols: [] };
    }

    const deps = await resolver.resolve();
    const symbols: vscode.SymbolInformation[] = [];

    for (const dep of deps) {
      if (!dep.localDir) continue;
      scanDirectorySync(dep.localDir, dep.name, symbols);
    }
    return { symbols, depCount: deps.filter(d => d.localDir).length };
  }
}

// ── File scanning (iterative, no recursion) ───────────────────────────────────

const SKIP_DIRS = new Set(['vendor', 'testdata', 'test', 'tests', 'examples', 'example']);

function scanDirectorySync(
  rootDir: string,
  moduleName: string,
  out: vscode.SymbolInformation[],
): void {
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch { // directory unreadable — skip
      continue;
    }

    const containerName = (() => {
      const rel = path.relative(rootDir, currentDir).replace(/\\/g, '/');
      return rel ? `Go - ${moduleName}/${rel}` : `Go - ${moduleName}`;
    })();

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
      } else if (entry.name.endsWith('.go') && !entry.name.endsWith('_test.go')) {
        scanFile(fullPath, containerName, out);
      }
    }
  }
}

function detectPackageName(dirPath: string): string | undefined {
  try {
    const entries = fs.readdirSync(dirPath);
    for (const name of entries) {
      if (!name.endsWith('.go') || name.endsWith('_test.go')) continue;
      const content = fs.readFileSync(path.join(dirPath, name), 'utf8');
      for (const line of content.split('\n')) {
        const m = line.match(PACKAGE_RE);
        if (m) return m[1];
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

function scanFile(
  filePath: string,
  containerName: string,
  out: vscode.SymbolInformation[],
): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  const uri = vscode.Uri.file(filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name: string | undefined;
    let kind: vscode.SymbolKind | undefined;

    let m = line.match(FUNC_RE);
    if (m) { name = m[1]; kind = vscode.SymbolKind.Function; }

    if (!name) {
      m = line.match(METHOD_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Method; }
    }

    if (!name) {
      m = line.match(STRUCT_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Struct; }
    }

    if (!name) {
      m = line.match(IFACE_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Interface; }
    }

    if (!name || kind === undefined) continue;

    out.push(new vscode.SymbolInformation(
      name,
      kind,
      containerName,
      new vscode.Location(uri, new vscode.Position(i, 0)),
    ));
  }
}
