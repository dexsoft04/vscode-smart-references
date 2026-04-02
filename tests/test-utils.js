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

// ── Reference scope anchor tests ────────────────────────────────────────────

function filterByScopeAnchor(refs, scopeFilter, anchorPath) {
  if (scopeFilter === 'currentFile') {
    return refs.filter(ref => ref.path === anchorPath);
  }
  if (scopeFilter === 'currentDirectory') {
    const anchorDir = anchorPath.split('/').slice(0, -1).join('/');
    return refs.filter(ref => ref.path.split('/').slice(0, -1).join('/') === anchorDir);
  }
  return refs;
}

group('Reference scope anchor — current file stays anchored to query file', () => {
  const refs = [
    { path: 'src/query.ts' },
    { path: 'src/other.ts' },
  ];
  const filtered = filterByScopeAnchor(refs, 'currentFile', 'src/query.ts');
  assert(filtered.length === 1, 'only keeps the query file');
  assert(filtered[0].path === 'src/query.ts', 'keeps query file reference even after browsing elsewhere');
});

group('Reference scope anchor — current directory stays anchored to query directory', () => {
  const refs = [
    { path: 'src/query.ts' },
    { path: 'src/other.ts' },
    { path: 'test/query.test.ts' },
  ];
  const filtered = filterByScopeAnchor(refs, 'currentDirectory', 'src/query.ts');
  assert(filtered.length === 2, 'keeps only references under the query directory');
  assert(filtered.every(ref => ref.path.startsWith('src/')), 'all results stay in src directory');
});

// ── Text search flat search tests ───────────────────────────────────────────

function groupMatchesByFile(matches) {
  const buckets = new Map();
  for (const match of matches) {
    const bucket = buckets.get(match.relativePath) || [];
    bucket.push(match);
    buckets.set(match.relativePath, bucket);
  }
  return [...buckets.keys()].sort();
}

function findSubsequenceRange(lineText, query) {
  const caseSensitive = /[A-Z]/.test(query);
  const source = caseSensitive ? lineText : lineText.toLowerCase();
  const target = caseSensitive ? query : query.toLowerCase();
  let first = -1;
  let last = -1;
  let cursor = 0;
  for (const ch of target) {
    const index = source.indexOf(ch, cursor);
    if (index === -1) return undefined;
    if (first === -1) first = index;
    last = index;
    cursor = index + 1;
  }
  return { start: first, end: last + 1 };
}

function mergeExcludeGlobs(searchExclude, filesExclude, customExclude) {
  const values = [
    ...Object.entries(searchExclude).filter(([, enabled]) => enabled === true).map(([glob]) => glob),
    ...Object.entries(filesExclude).filter(([, enabled]) => enabled === true).map(([glob]) => glob),
    ...customExclude,
  ];
  return [...new Set(values)].sort();
}

function splitGlobList(value) {
  const parts = [];
  let current = '';
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '{') braceDepth += 1;
    else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
    else if (ch === '[') bracketDepth += 1;
    else if (ch === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;

    if (ch === ',' && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      const normalized = current.trim();
      if (normalized) parts.push(normalized);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function globToSearchRegex(pattern) {
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

function resolveWhenTarget(relativePath, when) {
  const normalized = relativePath.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  const fileName = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const dirName = slashIndex >= 0 ? normalized.slice(0, slashIndex) : '';
  const dotIndex = fileName.lastIndexOf('.');
  const basename = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const replaced = when.replace(/\$\(basename\)/g, basename);
  return dirName ? `${dirName}/${replaced}` : replaced;
}

function shouldExcludeRelativePath(relativePath, folderPath, rules, existingFiles) {
  for (const rule of rules) {
    if (!rule.regex.test(relativePath)) continue;
    if (!rule.when) return true;
    const siblingRelativePath = resolveWhenTarget(relativePath, rule.when);
    if (existingFiles.has(`${folderPath}/${siblingRelativePath}`)) return true;
  }
  return false;
}

function findCommentStart(languageId, lineText) {
  const trimmed = lineText.trimStart();
  const leadingOffset = lineText.length - trimmed.length;
  if (trimmed.startsWith('*') || trimmed.startsWith('*/')) return leadingOffset;

  let style = 'slash';
  if (['python', 'shellscript', 'makefile', 'yaml', 'toml', 'dockercompose'].includes(languageId)) style = 'hash';
  else if (['lua', 'sql'].includes(languageId)) style = 'dashdash';
  else if (['html', 'xml', 'markdown'].includes(languageId)) style = 'xml';
  else if (['ini', 'properties'].includes(languageId)) style = 'semicolon';

  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let escaped = false;

  for (let index = 0; index < lineText.length; index++) {
    const ch = lineText[index];
    const next = lineText[index + 1] || '';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inSingle) {
      if (ch === '\\') escaped = true;
      else if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '\\') escaped = true;
      else if (ch === '`') inBacktick = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (style === 'slash' && ch === '/' && next === '/') return index;
    if (style === 'slash' && ch === '/' && next === '*') return index;
    if (style === 'hash' && ch === '#') return index;
    if (style === 'dashdash' && ch === '-' && next === '-') return index;
    if (style === 'xml' && ch === '<' && lineText.slice(index, index + 4) === '<!--') return index;
    if (style === 'semicolon' && ch === ';') return index;
  }
  return -1;
}

function buildSectionLabel(match, options) {
  const parts = [];
  if (options.groupCodeAndComments) parts.push(match.contentKind === 'comment' ? 'Comments' : 'Code');
  if (options.groupConfigAndCodeFiles) parts.push(match.fileKind === 'config' ? 'Config Files' : 'Code Files');
  return parts.join(' · ') || 'All';
}

function shortenTitlePart(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function buildTextSearchTitle(query, request, warning) {
  if (!query) return 'Text Search';
  const parts = [];
  if (request?.fuzzySearch) parts.push('fuzzy');
  else if (request?.useRegExp) parts.push('regex');
  if (request?.matchCase) parts.push('case');
  if (request?.matchWholeWord && !request?.fuzzySearch) parts.push('word');
  const includeParts = request?.include ? splitGlobList(request.include) : [];
  if (includeParts.length === 1) parts.push(`in:${shortenTitlePart(includeParts[0], 18)}`);
  else if (includeParts.length > 1) parts.push(`in:${shortenTitlePart(includeParts[0], 14)} +${includeParts.length - 1}`);
  const excludeParts = request?.exclude ? splitGlobList(request.exclude) : [];
  if (excludeParts.length === 1) parts.push(`out:${shortenTitlePart(excludeParts[0], 18)}`);
  else if (excludeParts.length > 1) parts.push(`out:${shortenTitlePart(excludeParts[0], 14)} +${excludeParts.length - 1}`);
  if (warning) parts.push('limited');
  const suffix = parts.length > 0 ? ` [${parts.join(', ')}]` : '';
  return `Text Search: ${shortenTitlePart(query, 48)}${suffix}`;
}

function isInsideSlashBlockComment(lines, lineIndex) {
  let inBlockComment = false;
  for (let index = 0; index <= lineIndex; index++) {
    const line = lines[index];
    if (inBlockComment) {
      if (index === lineIndex) return true;
      const closeIndex = line.indexOf('*/');
      if (closeIndex !== -1) inBlockComment = false;
      continue;
    }

    const openIndex = line.indexOf('/*');
    if (openIndex === -1) continue;
    const closeIndex = line.indexOf('*/', openIndex + 2);
    if (index === lineIndex) return true;
    if (closeIndex === -1) inBlockComment = true;
  }
  return false;
}

group('Text search flat list — groups by relative file path', () => {
  const matches = [
    { relativePath: 'assets/lobby/main/PhoneBind/PhoneBind.ts' },
    { relativePath: 'assets/lobby/main/PhoneBind/PhoneBind.ts' },
    { relativePath: 'assets/lobby/main/component/Login.ts' },
  ];
  const files = groupMatchesByFile(matches);
  assert(files.length === 2, 'deduplicates files into a flat list');
  assert(files[0] === 'assets/lobby/main/PhoneBind/PhoneBind.ts', 'keeps relative path as file label');
  assert(files[1] === 'assets/lobby/main/component/Login.ts', 'sorts by relative path');
});

group('Text search fuzzy matching — subsequence match works when enabled', () => {
  const range = findSubsequenceRange('relogin: true', 'rlt');
  assert(!!range, 'finds fuzzy subsequence match');
  assert(range.start === 0, 'fuzzy range starts at first matched character');
  assert(range.end === 10, 'fuzzy range ends at last matched character + 1');
  assert(findSubsequenceRange('relogin: true', 'rzz') === undefined, 'returns undefined when subsequence does not exist');
});

group('Text search globs — merges VS Code excludes with custom excludes', () => {
  const globs = mergeExcludeGlobs(
    { '**/dist/**': true, '**/coverage/**': false },
    { '**/node_modules/**': true },
    ['**/*.snap'],
  );
  assert(globs.length === 3, 'collects enabled search/files excludes and custom excludes');
  assert(globs.includes('**/dist/**'), 'includes search.exclude glob');
  assert(globs.includes('**/node_modules/**'), 'includes files.exclude glob');
  assert(globs.includes('**/*.snap'), 'includes custom exclude glob');
});

group('Text search globs — preserves brace patterns when splitting runtime input', () => {
  const globs = splitGlobList('src/**/*.{ts,tsx},test/**/*.{ts,tsx},**/*.spec.ts');
  assert(globs.length === 3, 'splits only at top-level commas');
  assert(globs[0] === 'src/**/*.{ts,tsx}', 'keeps first brace glob intact');
  assert(globs[1] === 'test/**/*.{ts,tsx}', 'keeps second brace glob intact');
  assert(globs[2] === '**/*.spec.ts', 'keeps plain glob intact');
});

group('Text search globs — respects conditional exclude rules', () => {
  const rules = [
    { pattern: '**/*.js', regex: globToSearchRegex('**/*.js'), when: '$(basename).ts' },
  ];
  const existingFiles = new Set(['workspace/src/login.ts']);
  assert(
    shouldExcludeRelativePath('src/login.js', 'workspace', rules, existingFiles) === true,
    'excludes generated file when the sibling source file exists',
  );
  assert(
    shouldExcludeRelativePath('src/standalone.js', 'workspace', rules, existingFiles) === false,
    'keeps file when the conditional sibling does not exist',
  );
});

group('Text search comments — does not treat URL markers as comments', () => {
  assert(
    findCommentStart('typescript', 'const url = "http://service/login";') === -1,
    'http:// inside a string should not be treated as a comment',
  );
  assert(
    findCommentStart('typescript', 'const value = 1; // login') === 17,
    'real inline comment stays detectable',
  );
});

group('Text search comments — keeps block comment body in the comment bucket', () => {
  const lines = [
    '/*',
    'login failed and needs retry',
    '*/',
  ];
  assert(isInsideSlashBlockComment(lines, 1) === true, 'block comment body line stays classified as comment');
});

group('Text search sections — builds configurable section labels', () => {
  const match = { contentKind: 'comment', fileKind: 'config' };
  assert(
    buildSectionLabel(match, { groupCodeAndComments: true, groupConfigAndCodeFiles: true }) === 'Comments · Config Files',
    'supports combined comment/config grouping',
  );
  assert(
    buildSectionLabel(match, { groupCodeAndComments: false, groupConfigAndCodeFiles: true }) === 'Config Files',
    'supports config/code file grouping only',
  );
  assert(
    buildSectionLabel(match, { groupCodeAndComments: true, groupConfigAndCodeFiles: false }) === 'Comments',
    'supports code/comment grouping only',
  );
});

group('Text search title — summarizes active search conditions', () => {
  const title = buildTextSearchTitle('login', {
    include: 'src/**/*.{ts,tsx},test/**/*.ts',
    exclude: '**/*.spec.ts',
    useRegExp: true,
    matchCase: true,
    matchWholeWord: true,
    fuzzySearch: false,
  }, 'limited');
  assert(title.includes('regex'), 'includes regex mode');
  assert(title.includes('case'), 'includes case-sensitive mode');
  assert(title.includes('word'), 'includes whole-word mode');
  assert(title.includes('in:src/**/*.{ts,'), 'includes summarized include glob');
  assert(title.includes('out:**/*.spec.ts'), 'includes summarized exclude glob');
  assert(title.includes('limited'), 'includes truncation warning marker');
});

function collectConfiguredExcludeGlobs(config) {
  return Object.entries(config)
    .filter(([, value]) => value === true || (value && typeof value === 'object'))
    .map(([glob]) => glob)
    .sort();
}

function getAdjustedOffsetForTests(originalOffset, applied) {
  let delta = 0;
  for (const change of applied) {
    if (change.originalStart < originalOffset) delta += change.delta;
  }
  return originalOffset + delta;
}

function utf8ByteOffsetToUtf16ColumnForTests(lineText, byteOffset) {
  const buffer = Buffer.from(lineText, 'utf8');
  const clampedOffset = Math.max(0, Math.min(byteOffset, buffer.length));
  return buffer.subarray(0, clampedOffset).toString('utf8').length;
}

function buildLineOffsetsForTests(value) {
  const offsets = [0];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function offsetAtForTests(lineOffsets, line, character) {
  return (lineOffsets[line] ?? lineOffsets[lineOffsets.length - 1] ?? 0) + character;
}

function positionAtOffsetForTests(lineOffsets, content, offset) {
  const clampedOffset = Math.max(0, Math.min(offset, content.length));
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (lineOffsets[mid] <= clampedOffset) low = mid;
    else high = mid - 1;
  }
  return { line: low, character: clampedOffset - (lineOffsets[low] ?? 0) };
}

function applyReplacementTextForTests(matchedText, request) {
  if (!request.useRegExp) return request.replaceText;
  const flags = request.matchCase ? 'u' : 'iu';
  return matchedText.replace(new RegExp(request.query, flags), request.replaceText);
}

function renderHighlightedTextForTests(lineText, startCharacter, endCharacter) {
  const before = lineText.slice(0, startCharacter);
  const hit = lineText.slice(startCharacter, endCharacter);
  const after = lineText.slice(endCharacter);
  return [before, hit, after];
}

function buildCriteriaSignatureForTests(request, groupingMode) {
  return JSON.stringify({
    query: request.query,
    include: request.include,
    exclude: request.exclude,
    useRegExp: request.useRegExp,
    matchCase: request.matchCase,
    matchWholeWord: request.matchWholeWord,
    fuzzySearch: request.fuzzySearch,
    beforeContextLines: request.beforeContextLines,
    afterContextLines: request.afterContextLines,
    groupingMode,
  });
}

group('Text search draft state — replace text alone does not stale the result set', () => {
  const rendered = {
    query: 'login',
    replaceText: '',
    include: '',
    exclude: '',
    useRegExp: false,
    matchCase: false,
    matchWholeWord: false,
    fuzzySearch: false,
    beforeContextLines: 2,
    afterContextLines: 3,
  };
  const draft = { ...rendered, replaceText: 'signin' };
  assert(
    buildCriteriaSignatureForTests(rendered, 'none') === buildCriteriaSignatureForTests(draft, 'none'),
    'ignores replaceText when checking whether displayed results are stale',
  );
});

group('Text search draft state — changing include marks displayed results as stale', () => {
  const rendered = {
    query: 'login',
    replaceText: '',
    include: '',
    exclude: '',
    useRegExp: false,
    matchCase: false,
    matchWholeWord: false,
    fuzzySearch: false,
    beforeContextLines: 2,
    afterContextLines: 3,
  };
  const draft = { ...rendered, include: 'src/**/*.ts' };
  assert(
    buildCriteriaSignatureForTests(rendered, 'none') !== buildCriteriaSignatureForTests(draft, 'none'),
    'treats search-affecting edits as stale and forces a new search before replace',
  );
});

group('Text search excludes — keeps object-form VS Code rules', () => {
  const globs = collectConfiguredExcludeGlobs({
    '**/*.js': { when: '$(basename).ts' },
    '**/dist/**': true,
    '**/coverage/**': false,
  });
  assert(globs.length === 2, 'collects boolean and object-form exclude rules');
  assert(globs.includes('**/*.js'), 'keeps conditional exclude rule');
  assert(globs.includes('**/dist/**'), 'keeps boolean exclude rule');
});

group('Text search replace — adjusts offsets after earlier replacements', () => {
  const adjusted = getAdjustedOffsetForTests(10, [
    { originalStart: 2, delta: 3 },
    { originalStart: 8, delta: -1 },
    { originalStart: 12, delta: 5 },
  ]);
  assert(adjusted === 12, 'applies only deltas before the current original offset');
});

group('Text search replace — supports regex capture replacement', () => {
  const replaced = applyReplacementTextForTests('login failed', {
    query: '(login) (failed)',
    replaceText: '$2: $1',
    useRegExp: true,
    matchCase: true,
  });
  assert(replaced === 'failed: login', 'reuses capture groups in replacement text');
});

group('Text search rg offsets — converts UTF-8 byte offsets to VS Code columns', () => {
  const lineText = '前缀😀login';
  const start = utf8ByteOffsetToUtf16ColumnForTests(lineText, Buffer.byteLength('前缀😀', 'utf8'));
  const end = utf8ByteOffsetToUtf16ColumnForTests(lineText, Buffer.byteLength('前缀😀login', 'utf8'));
  assert(start === 4, 'maps UTF-8 byte start to UTF-16 column');
  assert(end === 9, 'maps UTF-8 byte end to UTF-16 column');
});

group('Text search replace — recalculates positions against the current file text', () => {
  const originalText = 'foo\nbar baz\nqux';
  const originalLineOffsets = buildLineOffsetsForTests(originalText);
  const firstOriginalStart = offsetAtForTests(originalLineOffsets, 0, 0);
  const firstOriginalEnd = offsetAtForTests(originalLineOffsets, 0, 3);
  const replacementText = 'foo\nextra';
  const afterFirst = `${originalText.slice(0, firstOriginalStart)}${replacementText}${originalText.slice(firstOriginalEnd)}`;
  const secondOriginalStart = offsetAtForTests(originalLineOffsets, 1, 0);
  const secondAdjustedStart = getAdjustedOffsetForTests(secondOriginalStart, [{ originalStart: firstOriginalStart, delta: replacementText.length - 3 }]);
  const pos = positionAtOffsetForTests(buildLineOffsetsForTests(afterFirst), afterFirst, secondAdjustedStart);
  assert(pos.line === 2, 'moves the next replacement to the shifted line after newline insertion');
  assert(pos.character === 0, 'keeps the shifted replacement at the start of the line');
});

group('Text search highlight — isolates the matched substring range', () => {
  const parts = renderHighlightedTextForTests('relogin: true', 2, 7);
  assert(parts[0] === 're', 'keeps leading text before the match');
  assert(parts[1] === 'login', 'extracts the matched substring');
  assert(parts[2] === ': true', 'keeps trailing text after the match');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
