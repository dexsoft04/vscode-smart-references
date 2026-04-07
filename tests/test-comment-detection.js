'use strict';

// Mock the vscode module (commentDetection.ts imports it for detectContentKind)
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, parent, isMain, options);
};
require.cache['vscode'] = {
  id: 'vscode', filename: 'vscode', loaded: true, exports: {},
  children: [], paths: [],
};

const {
  getCommentSyntax,
  analyzeCommentRanges,
  buildCommentRangesByLine,
} = require('../out-tsc/providers/textSearch/commentDetection');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.error(`  \u2717 ${label}`);
    failed++;
  }
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ── getCommentSyntax ─────────────────────────────────────────────────────────

group('getCommentSyntax — slash languages', () => {
  for (const lang of ['javascript', 'typescript', 'go', 'java', 'csharp', 'rust', 'c', 'cpp']) {
    assert(getCommentSyntax(lang) === 'slash', `${lang} returns slash`);
  }
});

group('getCommentSyntax — hash languages', () => {
  for (const lang of ['python', 'shellscript', 'makefile', 'yaml', 'toml']) {
    assert(getCommentSyntax(lang) === 'hash', `${lang} returns hash`);
  }
});

group('getCommentSyntax — dashdash languages', () => {
  assert(getCommentSyntax('lua') === 'dashdash', 'lua returns dashdash');
  assert(getCommentSyntax('sql') === 'dashdash', 'sql returns dashdash');
});

group('getCommentSyntax — xml languages', () => {
  assert(getCommentSyntax('html') === 'xml', 'html returns xml');
  assert(getCommentSyntax('xml') === 'xml', 'xml returns xml');
  assert(getCommentSyntax('markdown') === 'xml', 'markdown returns xml');
});

group('getCommentSyntax — semicolon languages', () => {
  assert(getCommentSyntax('ini') === 'semicolon', 'ini returns semicolon');
  assert(getCommentSyntax('properties') === 'semicolon', 'properties returns semicolon');
});

// ── analyzeCommentRanges — slash syntax ──────────────────────────────────────

group('analyzeCommentRanges — single-line comment', () => {
  const result = analyzeCommentRanges('code // comment', 'slash', false);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 5, 'starts at 5');
  assert(result.ranges[0].end === 15, 'ends at 15');
  assert(result.nextInBlockComment === false, 'not in block');
});

group('analyzeCommentRanges — block comment opening', () => {
  const result = analyzeCommentRanges('code /* open block', 'slash', false);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 5, 'starts at 5');
  assert(result.nextInBlockComment === true, 'enters block comment');
});

group('analyzeCommentRanges — block comment closing', () => {
  const result = analyzeCommentRanges('still in block */ code', 'slash', true);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 0, 'starts at 0');
  assert(result.ranges[0].end === 17, 'ends after */');
  assert(result.nextInBlockComment === false, 'exits block comment');
});

group('analyzeCommentRanges — inline block comment', () => {
  const result = analyzeCommentRanges('a /* b */ c', 'slash', false);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 2, 'starts at 2');
  assert(result.ranges[0].end === 9, 'ends at 9');
  assert(result.nextInBlockComment === false, 'not in block');
});

group('analyzeCommentRanges — no comment', () => {
  const result = analyzeCommentRanges('pure code here', 'slash', false);
  assert(result.ranges.length === 0, 'no ranges');
  assert(result.nextInBlockComment === false, 'not in block');
});

group('analyzeCommentRanges — comment inside string is ignored', () => {
  const result = analyzeCommentRanges('"not // a comment"', 'slash', false);
  assert(result.ranges.length === 0, 'no ranges (comment inside double-quoted string)');
});

group('analyzeCommentRanges — hash comment', () => {
  const result = analyzeCommentRanges('x = 1 # comment', 'hash', false);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 6, 'starts at 6');
  assert(result.nextInBlockComment === false, 'not in block');
});

group('analyzeCommentRanges — dashdash comment', () => {
  const result = analyzeCommentRanges('SELECT * -- comment', 'dashdash', false);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 9, 'starts at 9');
});

group('analyzeCommentRanges — xml comment', () => {
  const result = analyzeCommentRanges('text <!-- comment --> more', 'xml', false);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 5, 'starts at 5');
  assert(result.ranges[0].end === 21, 'ends at 21');
  assert(result.nextInBlockComment === false, 'not in block');
});

group('analyzeCommentRanges — semicolon comment', () => {
  const result = analyzeCommentRanges('key=value ; comment', 'semicolon', false);
  assert(result.ranges.length === 1, 'one range');
  assert(result.ranges[0].start === 10, 'starts at 10');
});

// ── buildCommentRangesByLine ─────────────────────────────────────────────────

group('buildCommentRangesByLine — multi-line block comment', () => {
  const lines = [
    'code',
    'code /* start',
    'in block',
    'end */ code',
  ];
  const result = buildCommentRangesByLine(lines, 'javascript');
  assert(result[0].length === 0, 'line 0: no comment');
  assert(result[1].length === 1, 'line 1: block opens');
  assert(result[2].length === 1, 'line 2: entire line is comment');
  assert(result[2][0].start === 0, 'line 2: starts at 0');
  assert(result[3].length === 1, 'line 3: block closes');
  assert(result[3][0].end === 6, 'line 3: ends at */');
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nSome tests FAILED');
  process.exit(1);
} else {
  console.log('\nAll tests passed (' + passed + ').');
}
