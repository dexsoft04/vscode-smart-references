import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DepSymbolIndexer } from './GoDepSymbolIndexer';
import { CSharpDependencyResolver } from './CSharpDependencyResolver';

// ── Regex patterns for C# declarations ──────────────────────────────────────

const CLASS_RE     = /^\s*(?:public|internal)\s+(?:abstract\s+|sealed\s+|static\s+|partial\s+)*class\s+(\w+)/;
const INTERFACE_RE = /^\s*(?:public|internal)\s+(?:partial\s+)?interface\s+(\w+)/;
const STRUCT_RE    = /^\s*(?:public|internal)\s+(?:readonly\s+|ref\s+|partial\s+)*struct\s+(\w+)/;
const ENUM_RE      = /^\s*(?:public|internal)\s+enum\s+(\w+)/;
const RECORD_RE    = /^\s*(?:public|internal)\s+(?:sealed\s+|abstract\s+)*record\s+(?:struct\s+|class\s+)?(\w+)/;
const DELEGATE_RE  = /^\s*(?:public|internal)\s+delegate\s+\S+\s+(\w+)/;
const NAMESPACE_RE = /^\s*namespace\s+([\w.]+)/;

// ── CSharpDepSymbolIndexer ──────────────────────────────────────────────────

export class CSharpDepSymbolIndexer implements DepSymbolIndexer {
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
    this.log.appendLine('[cs-dep-index] building index...');

    const resolver = new CSharpDependencyResolver();
    const applicable = await resolver.detect();
    if (!applicable) {
      this.cache = [];
      this.dirty = false;
      this.log.appendLine('[cs-dep-index] no .csproj or Unity manifest found, index empty');
      return;
    }

    const deps = await resolver.resolve();
    const symbols: vscode.SymbolInformation[] = [];

    for (const dep of deps) {
      if (!dep.localDir) continue;
      scanCSharpDirectory(dep.localDir, dep.name, symbols);
    }

    this.cache = symbols;
    this.dirty = false;
    this.log.appendLine(
      `[cs-dep-index] done: ${symbols.length} symbols from ${deps.filter(d => d.localDir).length} deps in ${Date.now() - t0}ms`,
    );
  }

  dispose(): void { /* nothing to clean up */ }
}

// ── File scanning (iterative, no recursion) ─────────────────────────────────

const SKIP_DIRS = new Set(['bin', 'obj', 'test', 'tests', 'testdata', '.git', 'node_modules']);
const SKIP_FILE_SUFFIXES = ['Tests.cs', 'Test.cs', '.Designer.cs', 'AssemblyInfo.cs'];

function scanCSharpDirectory(
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

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
      } else if (entry.name.endsWith('.cs') && !shouldSkipFile(entry.name)) {
        scanCSharpFile(fullPath, moduleName, out);
      }
    }
  }
}

function shouldSkipFile(name: string): boolean {
  return SKIP_FILE_SUFFIXES.some(suffix => name.endsWith(suffix));
}

function scanCSharpFile(
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
  let currentNamespace = `C# - ${containerName}`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track namespace changes
    const nsMatch = line.match(NAMESPACE_RE);
    if (nsMatch) {
      currentNamespace = `C# - ${nsMatch[1]}`;
      continue;
    }

    let name: string | undefined;
    let kind: vscode.SymbolKind | undefined;

    let m = line.match(CLASS_RE);
    if (m) { name = m[1]; kind = vscode.SymbolKind.Class; }

    if (!name) {
      m = line.match(INTERFACE_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Interface; }
    }

    if (!name) {
      m = line.match(STRUCT_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Struct; }
    }

    if (!name) {
      m = line.match(ENUM_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Enum; }
    }

    if (!name) {
      m = line.match(RECORD_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Class; }
    }

    if (!name) {
      m = line.match(DELEGATE_RE);
      if (m) { name = m[1]; kind = vscode.SymbolKind.Function; }
    }

    if (!name || kind === undefined) continue;

    out.push(new vscode.SymbolInformation(
      name,
      kind,
      currentNamespace,
      new vscode.Location(uri, new vscode.Position(i, 0)),
    ));
  }
}
