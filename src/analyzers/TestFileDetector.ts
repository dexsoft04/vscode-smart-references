import * as vscode from 'vscode';

const DEFAULT_TEST_PATTERNS = [
  '**/*_test.go',
  '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx',
  '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx',
  '**/__tests__/**',
  '**/test_*.py', '**/*_test.py', '**/tests/**/*.py',
  '**/src/test/**',
  '**/*Test.java',
  '**/*Test.kt', '**/*Tests.kt', '**/*Spec.kt',
  '**/*_test.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/*.{test,spec}.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/*Test.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/*Tests.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/*_unittest.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/*UnitTest.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/test/**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/tests/**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}',
  '**/*Test.swift', '**/*Tests.swift', '**/*Spec.swift', '**/Tests/**/*.swift', '**/tests/**/*.swift',
  '**/*_test.rs', '**/*_tests.rs', '**/tests/**/*.rs', '**/benches/**/*.rs',
  '**/*Test.cs', '**/*Tests.cs', '**/Tests/**/*.cs', '**/*.Tests/**',
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
