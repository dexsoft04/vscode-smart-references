import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PythonDependencyResolver, resolvePackageDir } from '../core/PythonDependencyResolver';

// ── Python import statement Document Link Provider ───────────────────────────
// Makes `import X` and `from X import Y` statements clickable, jumping to
// the package source in site-packages or the active virtualenv.

// Matches: import foo, import foo.bar, from foo import bar, from foo.bar import baz
const IMPORT_RE  = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)/;
const FROM_RE    = /^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/;

// Standard library top-level modules — skip linking these
const STDLIB_ROOTS = new Set([
  'abc', 'ast', 'asyncio', 'builtins', 'cgi', 'cmath', 'cmd', 'code',
  'codecs', 'collections', 'concurrent', 'contextlib', 'copy', 'csv',
  'ctypes', 'dataclasses', 'datetime', 'decimal', 'difflib', 'dis',
  'email', 'encodings', 'enum', 'errno', 'faulthandler', 'fileinput',
  'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt',
  'getpass', 'gettext', 'glob', 'gzip', 'hashlib', 'heapq', 'hmac',
  'html', 'http', 'idlelib', 'imaplib', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'lib2to3', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'math', 'mimetypes',
  'mmap', 'multiprocessing', 'netrc', 'numbers', 'operator', 'os',
  'pathlib', 'pdb', 'pickle', 'pkgutil', 'platform', 'plistlib',
  'poplib', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'py_compile',
  'pyclbr', 'pydoc', 'queue', 'quopri', 'random', 're', 'readline',
  'reprlib', 'rlcompleter', 'runpy', 'sched', 'secrets', 'select',
  'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib',
  'sndhdr', 'socket', 'socketserver', 'spwd', 'sqlite3', 'ssl',
  'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess',
  'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
  'tarfile', 'telnetlib', 'tempfile', 'termios', 'test', 'textwrap',
  'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize',
  'tomllib', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle',
  'turtledemo', 'types', 'typing', 'unicodedata', 'unittest', 'urllib',
  'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser',
  'wsgiref', 'xdrlib', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport',
  'zlib', 'zoneinfo', '__future__',
]);

export class PythonImportLinkProvider implements vscode.DocumentLinkProvider, vscode.Disposable {
  private readonly log: vscode.OutputChannel;
  private siteMapPromise: Promise<Map<string, string>> | undefined;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  invalidateCache(): void {
    this.siteMapPromise = undefined;
  }

  async provideDocumentLinks(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentLink[]> {
    const siteMap = await this.getSiteMap();
    if (token.isCancellationRequested || siteMap.size === 0) return [];

    const text = document.getText();
    const lines = text.split('\n');
    const links: vscode.DocumentLink[] = [];

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (token.isCancellationRequested) break;
      const line = lines[lineIdx];

      // Stop when we reach the first non-import line that signals code start
      const trimmed = line.trim();
      if (
        trimmed &&
        !trimmed.startsWith('#') &&
        !trimmed.startsWith('import ') &&
        !trimmed.startsWith('from ') &&
        !trimmed.startsWith('"""') &&
        !trimmed.startsWith("'''") &&
        !/^(if|try|__all__|__version__|__author__)/.test(trimmed)
      ) {
        // Allow __future__ and conditional imports anywhere in the first 50 lines
        if (lineIdx > 50) break;
      }

      let m = line.match(IMPORT_RE) ?? line.match(FROM_RE);
      if (!m) continue;

      const fullModule = m[1];
      const rootModule = fullModule.split('.')[0];

      if (STDLIB_ROOTS.has(rootModule)) continue;

      const pkgDir = siteMap.get(rootModule);
      if (!pkgDir) continue;

      const targetUri = buildPythonTargetUri(pkgDir, fullModule);
      if (!targetUri) continue;

      // Place link on the module name
      const moduleStart = line.indexOf(rootModule, line.startsWith('\s') ? 0 : line.indexOf('import'));
      if (moduleStart === -1) continue;

      const range = new vscode.Range(
        new vscode.Position(lineIdx, moduleStart),
        new vscode.Position(lineIdx, moduleStart + fullModule.length),
      );

      const link = new vscode.DocumentLink(range, targetUri);
      link.tooltip = `Open: ${vscode.workspace.asRelativePath(targetUri) || targetUri.fsPath}`;
      links.push(link);
    }

    this.log.appendLine(`[py-import] ${vscode.workspace.asRelativePath(document.uri)}: ${links.length} links`);
    return links;
  }

  /** Returns a map of root module name → package directory in site-packages. */
  private getSiteMap(): Promise<Map<string, string>> {
    if (!this.siteMapPromise) {
      this.siteMapPromise = this.buildSiteMap();
    }
    return this.siteMapPromise;
  }

  private async buildSiteMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const t0 = Date.now();

    const resolver = new PythonDependencyResolver();
    const applicable = await resolver.detect();
    if (!applicable) return map;

    const deps = await resolver.resolve();
    for (const dep of deps) {
      if (!dep.localDir) continue;
      const key = dep.name.replace(/-/g, '_');
      if (!map.has(key)) map.set(key, dep.localDir);
      // Also map the original name (with dashes)
      if (!map.has(dep.name)) map.set(dep.name, dep.localDir);
    }

    // Additionally, scan all site-packages dirs for installed packages
    // (catches packages installed outside requirements.txt)
    const siteDirs = await getSitePackagesDirsFromPython();
    for (const siteDir of siteDirs) {
      try {
        const entries = fs.readdirSync(siteDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('_') || entry.name.endsWith('.dist-info') || entry.name.endsWith('.data')) continue;
          if (!map.has(entry.name)) {
            map.set(entry.name, path.join(siteDir, entry.name));
          }
        }
      } catch { /* ignore */ }
    }

    this.log.appendLine(`[py-import] site map built: ${map.size} entries in ${Date.now() - t0}ms`);
    return map;
  }

  dispose(): void { /* nothing to clean up */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a jump target URI for a Python module import.
 * Tries to resolve submodule paths (e.g. `from requests.auth import X` → requests/auth.py)
 */
function buildPythonTargetUri(pkgDir: string, fullModule: string): vscode.Uri | undefined {
  const parts = fullModule.split('.');

  // Walk the module path: requests.auth → pkgDir/auth.py or pkgDir/auth/__init__.py
  if (parts.length > 1) {
    let current = pkgDir;
    for (const part of parts.slice(1)) {
      const subDir = path.join(current, part);
      const subFile = path.join(current, `${part}.py`);
      if (fs.existsSync(subDir)) {
        current = subDir;
      } else if (fs.existsSync(subFile)) {
        return vscode.Uri.file(subFile);
      } else {
        break;
      }
    }
    // Landed on a directory — return its __init__.py if it exists
    const init = path.join(current, '__init__.py');
    if (fs.existsSync(init)) return vscode.Uri.file(init);
  }

  // Root module: prefer __init__.py inside the package directory
  const init = path.join(pkgDir, '__init__.py');
  if (fs.existsSync(init)) return vscode.Uri.file(init);

  // Single-file module (e.g. six.py stored as pkgDir itself is the .py file)
  if (pkgDir.endsWith('.py') && fs.existsSync(pkgDir)) {
    return vscode.Uri.file(pkgDir);
  }

  return undefined;
}

import { exec } from 'child_process';

function getSitePackagesDirsFromPython(): Promise<string[]> {
  return new Promise(resolve => {
    const cmd = 'python3 -c "import site,json;dirs=getattr(site,\'getsitepackages\',lambda:[])();u=site.getusersitepackages();print(json.dumps(list(set(dirs+[u]))))"';
    exec(cmd, { encoding: 'utf8' }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(Array.isArray(parsed) ? parsed.filter((d: unknown) => typeof d === 'string' && fs.existsSync(d as string)) : []);
      } catch {
        resolve([]);
      }
    });
  });
}
