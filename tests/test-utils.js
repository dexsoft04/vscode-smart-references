'use strict';

// ── Inline the pure functions under test ──────────────────────────────────────

function globToRegex(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
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

function decodeTokens(data) {
  const result = [];
  let line = 0;
  let startChar = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaStart = data[i + 1];
    const length = data[i + 2];
    const tokenTypeIndex = data[i + 3];
    if (deltaLine > 0) {
      line += deltaLine;
      startChar = deltaStart;
    } else {
      startChar += deltaStart;
    }
    result.push({ line, startChar, length, tokenTypeIndex });
  }
  return result;
}

// ── Mini test runner ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ── globToRegex tests ─────────────────────────────────────────────────────────

group('globToRegex — Go test files', () => {
  const rx = globToRegex('**/*_test.go');
  assert(rx.test('/project/pkg/server_test.go'), 'matches nested *_test.go');
  assert(rx.test('/project/server_test.go'), 'matches root-level *_test.go');
  assert(!rx.test('/project/server.go'), 'rejects non-test .go');
  assert(!rx.test('/project/testserver.go'), 'rejects testserver.go (no underscore)');
});

group('globToRegex — JS/TS test files (brace expansion)', () => {
  const rx = globToRegex('**/*.{test,spec}.{ts,tsx,js,jsx}');
  assert(rx.test('/project/src/foo.test.ts'), 'matches foo.test.ts');
  assert(rx.test('/project/src/foo.spec.tsx'), 'matches foo.spec.tsx');
  assert(rx.test('/project/foo.test.js'), 'matches foo.test.js');
  assert(rx.test('/project/foo.spec.jsx'), 'matches foo.spec.jsx');
  assert(!rx.test('/project/foo.ts'), 'rejects plain .ts');
  assert(!rx.test('/project/foo.testts'), 'rejects no dot before extension');
});

group('globToRegex — __tests__ directory', () => {
  const rx = globToRegex('**/__tests__/**');
  assert(rx.test('/project/src/__tests__/foo.ts'), 'matches inside __tests__');
  assert(rx.test('/project/__tests__/bar/baz.js'), 'matches nested inside __tests__');
  assert(!rx.test('/project/src/foo.test.ts'), 'rejects files outside __tests__');
});

group('globToRegex — Python test files', () => {
  const rxPrefix = globToRegex('**/test_*.py');
  assert(rxPrefix.test('/project/tests/test_server.py'), 'matches test_*.py');
  assert(!rxPrefix.test('/project/tests/server_test.py'), 'rejects *_test.py for test_ pattern');

  const rxSuffix = globToRegex('**/*_test.py');
  assert(rxSuffix.test('/project/server_test.py'), 'matches *_test.py');

  const rxDir = globToRegex('**/tests/**/*.py');
  assert(rxDir.test('/project/tests/unit/test_foo.py'), 'matches tests/**/*.py');
  assert(!rxDir.test('/project/src/foo.py'), 'rejects files outside tests/');
});

group('globToRegex — Java test files', () => {
  const rx = globToRegex('**/*Test.java');
  assert(rx.test('/project/src/ServerTest.java'), 'matches *Test.java');
  assert(!rx.test('/project/src/Server.java'), 'rejects non-test java');
});

group('globToRegex — src/test hierarchy (Maven)', () => {
  const rx = globToRegex('**/src/test/**');
  assert(rx.test('/project/src/test/java/FooTest.java'), 'matches src/test/**');
  assert(!rx.test('/project/src/main/java/Foo.java'), 'rejects src/main');
});

// ── decodeTokens tests ────────────────────────────────────────────────────────

group('decodeTokens — single token', () => {
  // One token: line=3, startChar=5, length=10, tokenType=2, modifiers=0
  const data = new Uint32Array([3, 5, 10, 2, 0]);
  const tokens = decodeTokens(data);
  assert(tokens.length === 1, 'produces 1 token');
  assert(tokens[0].line === 3, 'line is 3');
  assert(tokens[0].startChar === 5, 'startChar is 5');
  assert(tokens[0].length === 10, 'length is 10');
  assert(tokens[0].tokenTypeIndex === 2, 'tokenTypeIndex is 2');
});

group('decodeTokens — two tokens on same line', () => {
  // Token 1: absolute line=0, char=0, len=3, type=1
  // Token 2: deltaLine=0, deltaStart=5 → same line=0, char=5, len=2, type=0
  const data = new Uint32Array([0, 0, 3, 1, 0,  0, 5, 2, 0, 0]);
  const tokens = decodeTokens(data);
  assert(tokens.length === 2, 'produces 2 tokens');
  assert(tokens[0].line === 0 && tokens[0].startChar === 0, 'token 0 at (0,0)');
  assert(tokens[1].line === 0 && tokens[1].startChar === 5, 'token 1 at (0,5)');
});

group('decodeTokens — tokens on different lines', () => {
  // Token 1: line=1, char=0, len=5, type=3
  // Token 2: deltaLine=2 → line=3, char=4, len=3, type=0
  const data = new Uint32Array([1, 0, 5, 3, 0,  2, 4, 3, 0, 0]);
  const tokens = decodeTokens(data);
  assert(tokens.length === 2, 'produces 2 tokens');
  assert(tokens[0].line === 1, 'token 0 on line 1');
  assert(tokens[1].line === 3, 'token 1 on line 3');
  assert(tokens[1].startChar === 4, 'token 1 startChar is 4 (absolute, not delta)');
});

group('decodeTokens — malformed data (length not multiple of 5)', () => {
  // 9 entries = 1 complete group + 4 extra (ignored)
  const data = new Uint32Array([0, 0, 3, 1, 0,  0, 5, 2, 0]);
  const tokens = decodeTokens(data);
  assert(tokens.length === 1, 'processes only complete groups');
});

group('decodeTokens — empty data', () => {
  const tokens = decodeTokens(new Uint32Array([]));
  assert(tokens.length === 0, 'empty data produces no tokens');
});

// ── extractDocComment tests ──────────────────────────────────────────────────

// Simulate a minimal TextDocument for testing
function mockDocument(lines) {
  return {
    lineAt(n) { return { text: lines[n] ?? '' }; },
  };
}

function extractDocComment(doc, symbolStartLine) {
  // Inline trailing comment
  const lineText = doc.lineAt(symbolStartLine).text;
  const inlineMatch = lineText.match(/\/\/\s?(.*)/);
  if (inlineMatch && !lineText.trimStart().startsWith('//')) {
    return inlineMatch[1].trim() || undefined;
  }
  // Doc comment above
  let line = symbolStartLine - 1;
  let firstComment = '';
  while (line >= 0) {
    const text = doc.lineAt(line).text.trimStart();
    if (text.startsWith('//')) {
      firstComment = text.replace(/^\/\/\s?/, '');
      line--;
    } else {
      break;
    }
  }
  return firstComment || undefined;
}

group('extractDocComment — doc comment above', () => {
  const doc = mockDocument([
    '// Worker handles background tasks',
    'type Worker struct {',
  ]);
  assert(extractDocComment(doc, 1) === 'Worker handles background tasks', 'extracts first line of doc comment');
});

group('extractDocComment — multi-line doc comment', () => {
  const doc = mockDocument([
    '// Start begins processing.',
    '// It blocks until done.',
    'func (w *Worker) Start() {',
  ]);
  assert(extractDocComment(doc, 2) === 'Start begins processing.', 'extracts top line of multi-line comment');
});

group('extractDocComment — inline trailing comment', () => {
  const doc = mockDocument([
    '  Name string // Worker name',
  ]);
  assert(extractDocComment(doc, 0) === 'Worker name', 'extracts inline trailing comment');
});

group('extractDocComment — no comment', () => {
  const doc = mockDocument([
    '',
    'type Foo struct {',
  ]);
  assert(extractDocComment(doc, 1) === undefined, 'returns undefined when no comment');
});

group('extractDocComment — comment-only line not treated as inline', () => {
  const doc = mockDocument([
    '// This is a comment line',
  ]);
  // Line 0 starts with //, so inline match is skipped, goes to "above" logic which finds nothing above line -1
  assert(extractDocComment(doc, 0) === undefined, 'comment-only line at start returns undefined');
});

// ── groupMethodsUnderTypes tests ────────────────────────────────────────────

function groupMethodsUnderTypes(symbols) {
  const RECEIVER_RE = /^\(\*?(\w+)\)\.(.+)$/;
  const typeMap = new Map();
  const topLevel = [];
  const orphanMethods = [];
  for (const sym of symbols) {
    if (['Struct', 'Class', 'Interface'].includes(sym.kind)) {
      typeMap.set(sym.name, sym);
    }
  }
  for (const sym of symbols) {
    const m = RECEIVER_RE.exec(sym.name);
    if (m) {
      const [, typeName, methodName] = m;
      const parent = typeMap.get(typeName);
      if (parent) {
        parent.children.push({ name: methodName, kind: sym.kind, children: sym.children });
      } else {
        orphanMethods.push(sym);
      }
    } else {
      topLevel.push(sym);
    }
  }
  topLevel.push(...orphanMethods);
  return topLevel;
}

group('groupMethodsUnderTypes — methods grouped under struct', () => {
  const symbols = [
    { name: 'Worker', kind: 'Struct', children: [] },
    { name: '(*Worker).Start', kind: 'Method', children: [] },
    { name: '(*Worker).Stop', kind: 'Method', children: [] },
    { name: 'NewWorker', kind: 'Function', children: [] },
  ];
  const result = groupMethodsUnderTypes(symbols);
  assert(result.length === 2, 'top-level has Worker + NewWorker');
  assert(result[0].name === 'Worker', 'Worker is first');
  assert(result[0].children.length === 2, 'Worker has 2 children');
  assert(result[0].children[0].name === 'Start', 'first child is Start (no receiver prefix)');
  assert(result[0].children[1].name === 'Stop', 'second child is Stop');
  assert(result[1].name === 'NewWorker', 'NewWorker stays top-level');
});

group('groupMethodsUnderTypes — orphan methods stay top-level', () => {
  const symbols = [
    { name: '(*Unknown).Do', kind: 'Method', children: [] },
  ];
  const result = groupMethodsUnderTypes(symbols);
  assert(result.length === 1, 'orphan method stays');
  assert(result[0].name === '(*Unknown).Do', 'keeps original name');
});

// ── buildDirIndex tests ─────────────────────────────────────────────────────

function buildDirIndex(files) {
  const index = new Map();
  const ensure = (dir) => {
    if (!index.has(dir)) index.set(dir, { subdirs: [], files: [] });
    return index.get(dir);
  };
  for (const file of files) {
    const parts = file.split('/');
    const fileName = parts[parts.length - 1];
    const parentDir = parts.length === 1 ? '' : parts.slice(0, -1).join('/');
    ensure(parentDir).files.push(fileName);
    for (let i = 1; i <= parts.length - 1; i++) {
      const parent = i === 1 ? '' : parts.slice(0, i - 1).join('/');
      const child = parts.slice(0, i).join('/');
      const entry = ensure(parent);
      if (!entry.subdirs.includes(child)) entry.subdirs.push(child);
      ensure(child);
    }
  }
  for (const entry of index.values()) {
    entry.subdirs.sort();
    entry.files.sort();
  }
  return index;
}

group('buildDirIndex — basic structure', () => {
  const index = buildDirIndex(['src/main.go', 'src/util.go', 'README.md']);
  const root = index.get('');
  assert(root.subdirs.length === 1 && root.subdirs[0] === 'src', 'root has one subdir: src');
  assert(root.files.length === 1 && root.files[0] === 'README.md', 'root has README.md');
  const src = index.get('src');
  assert(src.files.length === 2, 'src has 2 files');
  assert(src.files[0] === 'main.go', 'files sorted alphabetically');
});

group('buildDirIndex — nested dirs', () => {
  const index = buildDirIndex(['a/b/c.go']);
  const root = index.get('');
  assert(root.subdirs[0] === 'a', 'root → a');
  const a = index.get('a');
  assert(a.subdirs[0] === 'a/b', 'a → a/b');
  const ab = index.get('a/b');
  assert(ab.files[0] === 'c.go', 'a/b contains c.go');
});

group('buildDirIndex — empty input', () => {
  const index = buildDirIndex([]);
  assert(index.size === 0, 'empty files produces empty index');
});

// ── Search Type filtering tests ─────────────────────────────────────────────

const SymbolCategory = {
  Class: 'Classes',
  Interface: 'Interfaces',
  Enum: 'Enums',
  Function: 'Functions & Methods',
  Variable: 'Variables & Constants',
  Other: 'Other',
};

const SymbolKind = {
  Class: 'Class',
  Constructor: 'Constructor',
  Struct: 'Struct',
  TypeParameter: 'TypeParameter',
  Interface: 'Interface',
  Function: 'Function',
  Method: 'Method',
  Operator: 'Operator',
  Variable: 'Variable',
  Constant: 'Constant',
  Field: 'Field',
  Property: 'Property',
  Enum: 'Enum',
  EnumMember: 'EnumMember',
};

function symbolKindToCategory(kind) {
  switch (kind) {
    case SymbolKind.Class:
    case SymbolKind.Constructor:
    case SymbolKind.Struct:
    case SymbolKind.TypeParameter:
      return SymbolCategory.Class;
    case SymbolKind.Interface:
      return SymbolCategory.Interface;
    case SymbolKind.Function:
    case SymbolKind.Method:
    case SymbolKind.Operator:
      return SymbolCategory.Function;
    case SymbolKind.Variable:
    case SymbolKind.Constant:
    case SymbolKind.Field:
    case SymbolKind.Property:
      return SymbolCategory.Variable;
    case SymbolKind.Enum:
    case SymbolKind.EnumMember:
      return SymbolCategory.Enum;
    default:
      return SymbolCategory.Other;
  }
}

function isStrictTypeSearch(categories) {
  return categories.length > 0 && categories.every(category =>
    category === SymbolCategory.Class
    || category === SymbolCategory.Interface
    || category === SymbolCategory.Enum
  );
}

function matchesTypeSearchKind(kind, categories) {
  if (categories.includes(SymbolCategory.Class)) {
    if (kind === SymbolKind.Class || kind === SymbolKind.Struct || kind === SymbolKind.TypeParameter) {
      return true;
    }
  }
  if (categories.includes(SymbolCategory.Interface) && kind === SymbolKind.Interface) {
    return true;
  }
  if (categories.includes(SymbolCategory.Enum) && kind === SymbolKind.Enum) {
    return true;
  }
  return false;
}

function matchesActiveCategories(kind, categories) {
  if (categories.length === 0) return true;
  if (isStrictTypeSearch(categories)) return matchesTypeSearchKind(kind, categories);
  return categories.includes(symbolKindToCategory(kind));
}

group('Search Type filtering — strict type definitions only', () => {
  const cats = [SymbolCategory.Class, SymbolCategory.Interface, SymbolCategory.Enum];
  assert(matchesActiveCategories(SymbolKind.Class, cats), 'includes class');
  assert(matchesActiveCategories(SymbolKind.Struct, cats), 'includes struct');
  assert(matchesActiveCategories(SymbolKind.Interface, cats), 'includes interface');
  assert(matchesActiveCategories(SymbolKind.Enum, cats), 'includes enum');
  assert(!matchesActiveCategories(SymbolKind.Constructor, cats), 'excludes constructor');
  assert(!matchesActiveCategories(SymbolKind.EnumMember, cats), 'excludes enum member');
  assert(!matchesActiveCategories(SymbolKind.Method, cats), 'excludes method');
  assert(!matchesActiveCategories(SymbolKind.Constant, cats), 'excludes constant');
});

// ── TS/JS enum reference classification tests ───────────────────────────────

function isTypeLikeContainer(kind) {
  return kind === 'Class' || kind === 'Interface' || kind === 'Struct';
}

function isInFieldTypeAnnotation(ref, allSymbols) {
  const pos = ref.location.range.start;
  const line = ref.lineText;
  for (const { symbol: sym, parents } of allSymbols) {
    if ((sym.kind === 'Field' || sym.kind === 'Property')
      && sym.range.start <= pos && pos <= sym.range.end) {
      if (!parents.some(parent => isTypeLikeContainer(parent.kind))) continue;
      const eqIdx = line.indexOf('=', sym.selectionRange.endCharacter);
      if (eqIdx === -1 || pos.character < eqIdx) return true;
    }
  }
  return false;
}

group('Field declaration classification — exclude object literal property values', () => {
  const ref = {
    lineText: '  AdsResultCode: EAdsResult.RESULT_CODE_REWARTVIDEO_CANCEL,',
    location: { range: { start: { character: 29 } } },
  };
  const objectLiteralProperty = {
    symbol: {
      kind: 'Property',
      range: { start: { character: 2 }, end: { character: 65 } },
      selectionRange: { endCharacter: 15 },
    },
    parents: [{ kind: 'Method' }],
  };
  assert(!isInFieldTypeAnnotation(ref, [objectLiteralProperty]), 'object literal enum value stays a reference');
});

group('Field declaration classification — keep real class field type annotations', () => {
  const ref = {
    lineText: '  resultCode: EAdsResult = EAdsResult.RESULT_CODE_REWARTVIDEO_CANCEL;',
    location: { range: { start: { character: 14 } } },
  };
  const classField = {
    symbol: {
      kind: 'Property',
      range: { start: { character: 2 }, end: { character: 66 } },
      selectionRange: { endCharacter: 12 },
    },
    parents: [{ kind: 'Class' }],
  };
  assert(isInFieldTypeAnnotation(ref, [classField]), 'class field type annotation remains declaration');
});

// ── Reference scope filtering tests ─────────────────────────────────────────

function isWorkspaceSourcePath(workspaceRoot, fsPath) {
  if (!workspaceRoot) return false;
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = fsPath.replace(/\\/g, '/');
  if (!normalizedPath.startsWith(normalizedRoot + '/')) return false;
  const relative = normalizedPath.slice(normalizedRoot.length + 1);
  if (!relative || relative.endsWith('.d.ts')) return false;
  if (/(^|\/)(node_modules|vendor|dist|out|build|coverage|target|\.git)(\/|$)/.test(relative)) return false;
  return true;
}

group('Workspace source filtering — keeps workspace source files', () => {
  assert(
    isWorkspaceSourcePath('/repo', '/repo/src/app.ts'),
    'includes source file under workspace root',
  );
  assert(
    isWorkspaceSourcePath('/repo', '/repo/packages/web/components/Button.vue'),
    'includes nested workspace source file',
  );
});

group('Workspace source filtering — excludes declarations and generated dirs', () => {
  assert(
    !isWorkspaceSourcePath('/repo', '/repo/src/types/api.d.ts'),
    'excludes .d.ts files',
  );
  assert(
    !isWorkspaceSourcePath('/repo', '/repo/dist/app.js'),
    'excludes dist output',
  );
  assert(
    !isWorkspaceSourcePath('/repo', '/repo/out/generated.js'),
    'excludes out output',
  );
  assert(
    !isWorkspaceSourcePath('/repo', '/repo/build/index.js'),
    'excludes build output',
  );
  assert(
    !isWorkspaceSourcePath('/repo', '/repo/node_modules/pkg/index.js'),
    'excludes node_modules',
  );
  assert(
    !isWorkspaceSourcePath('/repo', '/repo/vendor/pkg/file.go'),
    'excludes vendor',
  );
  assert(
    !isWorkspaceSourcePath('/repo', '/other/src/app.ts'),
    'excludes files outside workspace root',
  );
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
