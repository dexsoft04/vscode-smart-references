import * as vscode from 'vscode';

const DEFAULT_TEST_PATTERNS = [
  '**/*_test.go',
  '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx',
  '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx',
  '**/__tests__/**',
  '**/test_*.py', '**/*_test.py', '**/tests/**/*.py',
  '**/src/test/**',
  '**/*Test.java', '**/*Test.kt',
  '**/tests/**/*.rs',
  '**/*Tests.cs', '**/*.Tests/**',
];

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  // Use placeholders so that the later single-* rule doesn't corrupt ** expansions
  let regStr = normalized
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '\x00DSTAR_SLASH\x00')
    .replace(/\*\*/g, '\x00DSTAR\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{([^}]+)\}/g, (_m, inner) => `(${inner.split(',').join('|')})`)
    .replace(/\x00DSTAR_SLASH\x00/g, '(.+/)?')
    .replace(/\x00DSTAR\x00/g, '.*');
  return new RegExp(`(^|/)${regStr}($|/)`);
}

export class TestFileDetector {
  private patterns: RegExp[] = [];

  constructor() {
    this.reload();
  }

  reload(): void {
    const config = vscode.workspace.getConfiguration('smartReferences');
    const raw: string[] = config.get('testFilePatterns', DEFAULT_TEST_PATTERNS);
    this.patterns = raw.map(globToRegex);
  }

  isTestFile(uri: vscode.Uri): boolean {
    const filePath = uri.fsPath.replace(/\\/g, '/');
    return this.patterns.some(rx => rx.test(filePath));
  }
}
