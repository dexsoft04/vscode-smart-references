import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DepSymbolIndexer } from './GoDepSymbolIndexer';
import { NodeDependencyResolver } from './NodeDependencyResolver';

const EXPORT_CLASS_RE = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Z]\w*)/;
const EXPORT_INTERFACE_RE = /^\s*export\s+(?:declare\s+)?interface\s+([A-Z]\w*)/;
const EXPORT_TYPE_RE = /^\s*export\s+(?:declare\s+)?type\s+([A-Z]\w*)/;
const EXPORT_ENUM_RE = /^\s*export\s+(?:declare\s+)?enum\s+([A-Z]\w*)/;
const EXPORT_FUNCTION_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
const EXPORT_CONST_RE = /^\s*export\s+(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\b/;
const MODULE_EXPORT_RE = /^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/;

const SCAN_EXTS = new Set(['.d.ts', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__tests__',
  'test',
  'tests',
  'fixtures',
  'examples',
  'docs',
  'coverage',
]);

export class NodeDepSymbolIndexer implements DepSymbolIndexer {
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
    this.log.appendLine('[node-dep-index] building index...');

    const resolver = new NodeDependencyResolver();
    const applicable = await resolver.detect();
    if (!applicable) {
      this.cache = [];
      this.dirty = false;
      this.log.appendLine('[node-dep-index] no Node project found, index empty');
      return;
    }

    const deps = await resolver.resolve();
    const symbols: vscode.SymbolInformation[] = [];

    for (const dep of deps) {
      if (!dep.localDir || dep.workspaceLocal) continue;
      scanNodeDependency(dep.localDir, dep.name, symbols);
    }

    this.cache = symbols;
    this.dirty = false;
    this.log.appendLine(
      `[node-dep-index] done: ${symbols.length} symbols from ${deps.filter(d => d.localDir && !d.workspaceLocal).length} deps in ${Date.now() - t0}ms`,
    );
  }

  dispose(): void { /* nothing to clean up */ }
}

function scanNodeDependency(
  rootDir: string,
  packageName: string,
  out: vscode.SymbolInformation[],
): void {
  const visited = new Set<string>();
  const queue = new Set<string>(discoverScanRoots(rootDir));

  if (queue.size === 0) {
    queue.add(rootDir);
  }

  for (const candidate of queue) {
    if (!fs.existsSync(candidate)) continue;
    if (!fs.statSync(candidate).isDirectory()) continue;
    scanDirectory(candidate, rootDir, packageName, out, visited);
  }
}

function discoverScanRoots(rootDir: string): string[] {
  const roots = new Set<string>();
  const packageJsonPath = path.join(rootDir, 'package.json');

  try {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      main?: string;
      module?: string;
      types?: string;
      typings?: string;
      exports?: unknown;
    };
    for (const relPath of collectEntryCandidates(manifest)) {
      const resolved = path.resolve(rootDir, relPath);
      const dir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? resolved
        : path.dirname(resolved);
      roots.add(dir);
    }
  } catch {
    // Fall back to standard source roots below.
  }

  for (const dirname of ['src', 'dist', 'lib', 'types']) {
    roots.add(path.join(rootDir, dirname));
  }

  return Array.from(roots);
}

function collectEntryCandidates(manifest: {
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
}): string[] {
  const result = new Set<string>();

  for (const key of [manifest.types, manifest.typings, manifest.module, manifest.main]) {
    if (typeof key === 'string' && key) result.add(key);
  }

  collectExportEntries(manifest.exports, result);
  return Array.from(result);
}

function collectExportEntries(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    out.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectExportEntries(item, out);
    return;
  }

  if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectExportEntries(nested, out);
    }
  }
}

function scanDirectory(
  scanRoot: string,
  packageRoot: string,
  packageName: string,
  out: vscode.SymbolInformation[],
  visited: Set<string>,
): void {
  const stack = [scanRoot];

  while (stack.length > 0) {
    const currentDir = stack.pop()!;
    let realDir = currentDir;
    try {
      realDir = fs.realpathSync(currentDir);
    } catch {
      realDir = currentDir;
    }

    if (visited.has(realDir)) continue;
    visited.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const relDir = path.relative(packageRoot, currentDir).replace(/\\/g, '/');
    const containerName = relDir
      ? `Node - ${packageName}/${relDir}`
      : `Node - ${packageName}`;

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
          stack.push(fullPath);
        }
        continue;
      }

      if (!hasSupportedExtension(entry.name)) continue;
      scanFile(fullPath, containerName, out);
    }
  }
}

function hasSupportedExtension(fileName: string): boolean {
  for (const ext of SCAN_EXTS) {
    if (fileName.endsWith(ext)) return true;
  }
  return false;
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

  const uri = vscode.Uri.file(filePath);
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let name: string | undefined;
    let kind: vscode.SymbolKind | undefined;

    let match = line.match(EXPORT_CLASS_RE);
    if (match) {
      name = match[1];
      kind = vscode.SymbolKind.Class;
    }

    if (!name) {
      match = line.match(EXPORT_INTERFACE_RE);
      if (match) {
        name = match[1];
        kind = vscode.SymbolKind.Interface;
      }
    }

    if (!name) {
      match = line.match(EXPORT_TYPE_RE);
      if (match) {
        name = match[1];
        kind = vscode.SymbolKind.Interface;
      }
    }

    if (!name) {
      match = line.match(EXPORT_ENUM_RE);
      if (match) {
        name = match[1];
        kind = vscode.SymbolKind.Enum;
      }
    }

    if (!name) {
      match = line.match(EXPORT_FUNCTION_RE);
      if (match) {
        name = match[1];
        kind = vscode.SymbolKind.Function;
      }
    }

    if (!name) {
      match = line.match(EXPORT_CONST_RE);
      if (match) {
        name = match[1];
        kind = vscode.SymbolKind.Constant;
      }
    }

    if (!name) {
      match = line.match(MODULE_EXPORT_RE);
      if (match) {
        name = match[1];
        kind = vscode.SymbolKind.Variable;
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
