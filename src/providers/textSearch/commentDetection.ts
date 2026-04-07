import * as vscode from 'vscode';
import { CommentSyntax, CommentRangesForLine, TextSearchContentKind } from './types';

export function getCommentSyntax(languageId: string): CommentSyntax {
  if (['python', 'shellscript', 'makefile', 'yaml', 'toml', 'dockercompose'].includes(languageId)) {
    return 'hash';
  }
  if (['lua', 'sql'].includes(languageId)) {
    return 'dashdash';
  }
  if (['html', 'xml', 'markdown'].includes(languageId)) {
    return 'xml';
  }
  if (['ini', 'properties'].includes(languageId)) {
    return 'semicolon';
  }
  return 'slash';
}

interface CommentTokens {
  block?: { start: string; end: string };
  line?: string;
}

function getCommentTokens(syntax: CommentSyntax): CommentTokens {
  switch (syntax) {
    case 'slash':     return { block: { start: '/*', end: '*/' }, line: '//' };
    case 'xml':       return { block: { start: '<!--', end: '-->' } };
    case 'hash':      return { line: '#' };
    case 'dashdash':  return { line: '--' };
    case 'semicolon': return { line: ';' };
  }
}

function skipStringLiteral(lineText: string, index: number, quote: string): number {
  for (let i = index + 1; i < lineText.length; i++) {
    if (lineText[i] === '\\') { i++; continue; }
    if (lineText[i] === quote) return i;
  }
  return lineText.length - 1;
}

function findCommentStart(
  lineText: string,
  cursor: number,
  tokens: CommentTokens,
): { kind: 'block' | 'line' | 'none'; index: number } {
  for (let i = cursor; i < lineText.length; i++) {
    const ch = lineText[i];

    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringLiteral(lineText, i, ch);
      continue;
    }

    if (tokens.block && lineText.startsWith(tokens.block.start, i)) {
      return { kind: 'block', index: i };
    }
    if (tokens.line && lineText.startsWith(tokens.line, i)) {
      return { kind: 'line', index: i };
    }
  }
  return { kind: 'none', index: -1 };
}

export function analyzeCommentRanges(lineText: string, syntax: CommentSyntax, inBlockComment: boolean): CommentRangesForLine {
  const ranges: Array<{ start: number; end: number }> = [];
  const tokens = getCommentTokens(syntax);
  let cursor = 0;
  let blockOpen = inBlockComment;

  while (cursor < lineText.length) {
    // Inside a block comment — scan for close token
    if (blockOpen && tokens.block) {
      const closeIndex = lineText.indexOf(tokens.block.end, cursor);
      if (closeIndex === -1) {
        ranges.push({ start: cursor, end: lineText.length });
        return { ranges, nextInBlockComment: true };
      }
      ranges.push({ start: cursor, end: closeIndex + tokens.block.end.length });
      cursor = closeIndex + tokens.block.end.length;
      blockOpen = false;
      continue;
    }

    // Outside comments — scan for comment start, skipping string literals
    const found = findCommentStart(lineText, cursor, tokens);

    if (found.kind === 'line') {
      ranges.push({ start: found.index, end: lineText.length });
      return { ranges, nextInBlockComment: false };
    }

    if (found.kind === 'block' && tokens.block) {
      const closeIndex = lineText.indexOf(tokens.block.end, found.index + tokens.block.start.length);
      if (closeIndex === -1) {
        ranges.push({ start: found.index, end: lineText.length });
        return { ranges, nextInBlockComment: true };
      }
      ranges.push({ start: found.index, end: closeIndex + tokens.block.end.length });
      cursor = closeIndex + tokens.block.end.length;
      continue;
    }

    // No comment found on remaining part of line
    return { ranges, nextInBlockComment: false };
  }

  return { ranges, nextInBlockComment: false };
}

export function buildCommentRangesByLine(lines: string[], languageId: string): Array<Array<{ start: number; end: number }>> {
  const syntax = getCommentSyntax(languageId);
  let inBlockComment = false;
  return lines.map(line => {
    const analyzed = analyzeCommentRanges(line, syntax, inBlockComment);
    inBlockComment = analyzed.nextInBlockComment;
    return analyzed.ranges;
  });
}

export function detectContentKind(commentRanges: Array<{ start: number; end: number }>, matchRange: vscode.Range): TextSearchContentKind {
  return commentRanges.some(range => matchRange.start.character >= range.start && matchRange.start.character < range.end)
    ? 'comment'
    : 'code';
}
