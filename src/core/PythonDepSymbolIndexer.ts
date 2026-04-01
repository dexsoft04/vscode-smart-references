import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DepSymbolIndexer } from './GoDepSymbolIndexer';
import { PythonDependencyResolver } from './PythonDependencyResolver';

// ── Regex patterns for public Python declarations ────────────────────────────

const CLASS_RE    = /^class\s+([A-Z]\w*)\s*[:(]/;
const FUNC_RE     = /^(?:async\s+)?def\s+([a-zA-Z][a-zA-Z0-9_]*)\s*\(/;
const MODULE_RE   = /^#\s*module:\s*([\w.]+)/i; // optional inline module hint

// ── PythonDepSymbolIndexer ───────────────────────────────────────────────────

export class PythonDepSymbolIndexer implements DepSymbolIndexer {
  private cache: vscode.SymbolInformation[] | undefined;
  private dirty = true;
  private readonly log: vscode.OutputChannel;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  invalidate(): void {
    this.dirty = true;
    this.cache = undefined;
  }

  async getSymbols(): Promise<vscode.SymbolInformation[]> {
    if (!this.dirty && this.cache) return this.cache;
    await this.buildIndex();
    return this.cache ?? [];
  }

  private async buildIndex(): Promise<void> {
    const t0 = Date.now();
    this.log.appendLine('[py-dep-index] building index...');

    const resolver = new PythonDependencyResolver();
    const applicable = await resolver.detect();
    if (!applicable) {
      this.cache = [];
      this.dirty = false;
      this.log.appendLine('[py-dep-index] no Python project found, index empty');
      return;
    }

    const deps = await resolver.resolve();
    const symbols: vscode.SymbolInformation[] = [];

    for (const dep of deps) {
      if (!dep.localDir) continue;
      scanPythonDirectory(dep.localDir, dep.name, symbols);
    }

    this.cache = symbols;
    this.dirty = false;
    this.log.appendLine(
      `[py-dep-index] done: ${symbols.length} symbols from ${deps.filter(d => d.localDir).length} deps in ${Date.now() - t0}ms`,
    );
  }

  dispose(): void { /* nothing to clean up */ }
}

// ── File scanning (iterative, no recursion) ──────────────────────────────────

const SKIP_DIRS = new Set([
  '__pycache__', '.git', 'test', 'tests', 'testing',
  'dist', 'build', 'doc', 'docs', 'examples', 'example',
]);

function scanPythonDirectory(
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
      return rel ? `Python - ${moduleName}/${rel}` : `Python - ${moduleName}`;
    })();

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
      } else if (entry.name.endsWith('.py') && !isTestFile(entry.name)) {
        scanPythonFile(fullPath, containerName, out);
      }
    }
  }
}

function isTestFile(name: string): boolean {
  return name.startsWith('test_') || name.endsWith('_test.py');
}

function scanPythonFile(
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

    // Only index top-level (unindented) declarations
    if (line.startsWith(' ') || line.startsWith('\t')) continue;

    let name: string | undefined;
    let kind: vscode.SymbolKind | undefined;

    let m = line.match(CLASS_RE);
    if (m) { name = m[1]; kind = vscode.SymbolKind.Class; }

    if (!name) {
      m = line.match(FUNC_RE);
      if (m) {
        name = m[1];
        kind = vscode.SymbolKind.Function;
      }
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
