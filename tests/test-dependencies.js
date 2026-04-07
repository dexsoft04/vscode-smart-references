'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parsePackageManifest,
  parsePackageLock,
  parsePnpmLock,
  parseYarnLock,
  resolvePackageLockVersion,
  resolvePnpmLockVersion,
  resolveYarnLockVersion,
  resolveNodePackageDir,
} = require('../out-tsc/core/NodeDependencyUtils.js');
const {
  isStructuredTextLanguage,
  parseStructuredText,
} = require('../out-tsc/core/StructuredTextParser.js');

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

group('parsePackageManifest', () => {
  const parsed = parsePackageManifest(JSON.stringify({
    name: 'demo-app',
    workspaces: ['packages/*', '!packages/ignored'],
    dependencies: { react: '^18.3.0' },
    devDependencies: { typescript: '^5.9.0' },
    peerDependencies: { vite: '^5.0.0' },
    optionalDependencies: { fsevents: '^2.3.0' },
  }));

  assert(parsed.name === 'demo-app', 'reads package name');
  assert(parsed.workspaces.length === 2, 'collects workspace globs');
  assert(parsed.dependencies.length === 4, 'collects all dependency sections');
  assert(parsed.dependencies.find(dep => dep.name === 'react').dependencyType === 'direct', 'marks dependencies as direct');
  assert(parsed.dependencies.find(dep => dep.name === 'typescript').dependencyType === 'dev', 'marks devDependencies as dev');
  assert(parsed.dependencies.find(dep => dep.name === 'vite').dependencyType === 'peer', 'marks peerDependencies as peer');
  assert(parsed.dependencies.find(dep => dep.name === 'fsevents').dependencyType === 'optional', 'marks optionalDependencies as optional');
});

group('parsePackageLock + resolvePackageLockVersion', () => {
  const lock = parsePackageLock(JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { react: '^18.3.0' },
      },
      'packages/app': {
        dependencies: { lodash: '^4.17.21' },
      },
      'node_modules/react': {
        version: '18.3.1',
      },
      'packages/app/node_modules/lodash': {
        version: '4.17.21',
      },
    },
  }));

  assert(resolvePackageLockVersion(lock, '.', 'react') === '18.3.1', 'resolves root dependency version');
  assert(resolvePackageLockVersion(lock, 'packages/app', 'lodash') === '4.17.21', 'resolves workspace importer dependency version');
});

group('parsePnpmLock + resolvePnpmLockVersion', () => {
  const lock = parsePnpmLock(`
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      react:
        specifier: ^18.3.0
        version: 18.3.1
  packages/app:
    devDependencies:
      typescript:
        specifier: ^5.9.0
        version: 5.9.3
`);

  assert(resolvePnpmLockVersion(lock, '.', 'react') === '18.3.1', 'reads root importer version');
  assert(resolvePnpmLockVersion(lock, 'packages/app', 'typescript') === '5.9.3', 'reads workspace importer version');
});

group('parseYarnLock + resolveYarnLockVersion', () => {
  const lock = parseYarnLock(`
"react@^18.3.0":
  version "18.3.1"

"@types/node@^18.0.0", "@types/node@^18.11.0":
  version "18.19.130"
`);

  assert(resolveYarnLockVersion(lock, 'react', '^18.3.0') === '18.3.1', 'resolves yarn selector version');
  assert(resolveYarnLockVersion(lock, '@types/node', '^18.11.0') === '18.19.130', 'resolves scoped yarn selector version');
});

group('resolveNodePackageDir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-refs-node-'));
  const workspaceDir = path.join(tmpDir, 'workspace');
  const nestedDir = path.join(workspaceDir, 'packages', 'app', 'src');
  const scopedDir = path.join(workspaceDir, 'node_modules', '@scope', 'pkg');

  fs.mkdirSync(nestedDir, { recursive: true });
  fs.mkdirSync(scopedDir, { recursive: true });

  const resolved = resolveNodePackageDir(nestedDir, '@scope/pkg');
  assert(resolved === scopedDir, 'walks upward and resolves scoped package from node_modules');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

group('structured text language detection', () => {
  assert(isStructuredTextLanguage('toml'), 'recognizes toml as structured text');
  assert(isStructuredTextLanguage('yaml'), 'recognizes yaml as structured text');
  assert(isStructuredTextLanguage('jsonc'), 'recognizes jsonc as structured text');
  assert(isStructuredTextLanguage('makefile'), 'recognizes makefile as structured text');
  assert(!isStructuredTextLanguage('typescript'), 'does not treat code files as structured text');
});

group('parseStructuredText — TOML', () => {
  const roots = parseStructuredText('toml', `
[server.http]
port = 8080
[database]
host = "localhost"
`);

  assert(roots.length === 2, 'creates top-level sections for toml tables');
  assert(roots[0].name === 'server', 'splits dotted toml table into parent section');
  assert(roots[0].children[0].name === 'http', 'creates nested toml section from dotted path');
  assert(roots[0].children[0].children[0].name === 'port', 'collects toml keys under current table');
});

group('parseStructuredText — YAML', () => {
  const roots = parseStructuredText('yaml', `
server:
  host: localhost
  routes:
    - /health
`);

  assert(roots.length === 1, 'creates yaml root key');
  assert(roots[0].name === 'server', 'keeps yaml key name');
  assert(roots[0].children[0].name === 'host', 'collects nested yaml key');
  assert(roots[0].children[1].name === 'routes', 'collects nested yaml section');
  assert(roots[0].children[1].children[0].name.startsWith('- '), 'collects yaml list items');
});

group('parseStructuredText — YAML list item objects', () => {
  const roots = parseStructuredText('yaml', `
steps:
  - name: Checkout
    uses: actions/checkout@v4
    with:
      fetch-depth: 1
`);

  const item = roots[0].children[0];
  assert(item.name === '- item', 'creates synthetic yaml item node for object list entries');
  assert(item.children[0].name === 'name', 'keeps inline key under yaml item');
  assert(item.children[1].name === 'uses', 'keeps sibling keys under same yaml item');
  assert(item.children[2].name === 'with', 'keeps nested object section under same yaml item');
  assert(item.children[2].children[0].name === 'fetch-depth', 'keeps nested yaml object under list item');
});

group('parseStructuredText — JSON/JSONC', () => {
  const roots = parseStructuredText('jsonc', `
{
  "compilerOptions": {
    "strict": true
  }
}
`);

  assert(roots.length === 1, 'creates json root property node');
  assert(roots[0].name === 'compilerOptions', 'reads json property name');
  assert(roots[0].children[0].name === 'strict', 'reads nested json property');
});

group('parseStructuredText — INI/properties', () => {
  const roots = parseStructuredText('ini', `
[redis]
host=127.0.0.1
port=6379
`);

  assert(roots.length === 1, 'creates ini section');
  assert(roots[0].children.length === 2, 'collects ini keys inside section');
  assert(roots[0].children[0].name === 'host', 'reads ini key name');
});

group('parseStructuredText — Markdown', () => {
  const roots = parseStructuredText('markdown', `
# Overview
## Install
## Usage
`);

  assert(roots.length === 1, 'creates top-level markdown heading');
  assert(roots[0].children.length === 2, 'nests child headings by level');
  assert(roots[0].children[0].name === 'Install', 'reads markdown heading text');
});

group('parseStructuredText — XML/HTML inline tags', () => {
  const roots = parseStructuredText('xml', '<root><a></a><b/></root>');

  assert(roots.length === 1, 'creates xml root node');
  assert(roots[0].name === 'root', 'reads xml root tag');
  assert(roots[0].children.length === 2, 'keeps sibling inline tags under root');
  assert(roots[0].children[0].name === 'a', 'keeps first inline child tag');
  assert(roots[0].children[1].name === 'b', 'keeps self-closing inline child tag');
});

group('parseStructuredText — Makefile', () => {
  const roots = parseStructuredText('makefile', `
IMAGE := demo
build: deps
\tgo build ./...
`);

  assert(roots.length === 2, 'collects makefile variables and targets');
  assert(roots[0].name === 'IMAGE', 'reads makefile variable');
  assert(roots[1].name === 'build', 'reads makefile target');
  assert(roots[1].children[0].detail === 'command', 'attaches recipe lines under target');
});

if (failed > 0) {
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
