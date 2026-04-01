import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GoModResolver } from './DependencyResolver';

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

export class GoDepSymbolIndexer implements DepSymbolIndexer {
  private cache: vscode.SymbolInformation[] | undefined;
  private dirty = true;
  private readonly log: vscode.OutputChannel;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  /** Mark index as stale (call when go.mod changes) */
  invalidate(): void {
    this.dirty = true;
    this.cache = undefined;
  }

  /**
   * Return all indexed symbols. Builds index on first call or after invalidate().
   * The QuickPick should set `busy=true` before calling this.
   */
  async getSymbols(): Promise<vscode.SymbolInformation[]> {
    if (!this.dirty && this.cache) return this.cache;
    await this.buildIndex();
    return this.cache ?? [];
  }

  private async buildIndex(): Promise<void> {
    const t0 = Date.now();
    this.log.appendLine('[dep-index] building index...');

    const resolver = new GoModResolver();
    const applicable = await resolver.detect();
    if (!applicable) {
      this.cache = [];
      this.dirty = false;
      this.log.appendLine('[dep-index] no go.mod found, index empty');
      return;
    }

    const deps = await resolver.resolve();
    const symbols: vscode.SymbolInformation[] = [];

    for (const dep of deps) {
      if (!dep.localDir) continue;
      scanDirectorySync(dep.localDir, dep.name, symbols);
    }

    this.cache = symbols;
    this.dirty = false;
    this.log.appendLine(`[dep-index] done: ${symbols.length} symbols from ${deps.filter(d => d.localDir).length} deps in ${Date.now() - t0}ms`);
  }

  dispose(): void { /* nothing to clean up */ }
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
    } catch {
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
