import * as path from 'path';
import * as vscode from 'vscode';
import { isStructuredTextLanguage } from '../../core/StructuredTextParser';
import {
  TextSearchFileKind, TextSearchMatch, TextSearchContextLine,
  TextSearchOptions, RawSearchMatch,
  CONFIG_BASENAMES, CONFIG_EXTENSIONS, OTHER_TEXT_EXTENSIONS, OTHER_TEXT_LANGUAGE_IDS,
} from './types';
import { buildCommentRangesByLine, detectContentKind } from './commentDetection';
import { t } from '../../i18n';

export function detectFileKind(document: vscode.TextDocument): TextSearchFileKind {
  const base = path.basename(document.uri.fsPath).toLowerCase();
  if (CONFIG_BASENAMES.has(base)) return 'config';
  const ext = path.extname(base);
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  if (OTHER_TEXT_EXTENSIONS.has(ext) || OTHER_TEXT_LANGUAGE_IDS.has(document.languageId)) return 'other';
  if (isStructuredTextLanguage(document.languageId) && !['markdown', 'html', 'xml'].includes(document.languageId)) {
    return 'config';
  }
  return 'code';
}

export function buildContext(lines: string[], lineNumber: number, beforeCount: number, afterCount: number): { beforeLines: TextSearchContextLine[]; afterLines: TextSearchContextLine[] } {
  const beforeLines: TextSearchContextLine[] = [];
  const afterLines: TextSearchContextLine[] = [];
  for (let index = Math.max(0, lineNumber - 1 - beforeCount); index < lineNumber - 1; index++) {
    beforeLines.push({ lineNumber: index + 1, text: lines[index] ?? '' });
  }
  for (let index = lineNumber; index < Math.min(lines.length, lineNumber + afterCount); index++) {
    afterLines.push({ lineNumber: index + 1, text: lines[index] ?? '' });
  }
  return { beforeLines, afterLines };
}

export function buildSectionLabel(match: TextSearchMatch, options: TextSearchOptions): string {
  const parts: string[] = [];
  if (options.groupCodeAndComments) parts.push(match.contentKind === 'comment' ? t('注释', 'Comments') : t('代码', 'Code'));
  if (options.groupConfigAndCodeFiles) {
    parts.push(
      match.fileKind === 'config'
        ? t('配置文件', 'Config Files')
        : match.fileKind === 'other'
          ? t('其他文件', 'Other Files')
          : t('代码文件', 'Code Files'),
    );
  }
  return parts.join(' · ') || t('全部', 'All');
}

export function getSectionSortOrder(label: string): number {
  switch (label) {
    case t('代码 · 代码文件', 'Code · Code Files'): return 0;
    case t('注释 · 代码文件', 'Comments · Code Files'): return 1;
    case t('代码 · 配置文件', 'Code · Config Files'): return 2;
    case t('注释 · 配置文件', 'Comments · Config Files'): return 3;
    case t('代码 · 其他文件', 'Code · Other Files'): return 4;
    case t('注释 · 其他文件', 'Comments · Other Files'): return 5;
    case t('代码', 'Code'): return 0;
    case t('注释', 'Comments'): return 1;
    case t('代码文件', 'Code Files'): return 0;
    case t('配置文件', 'Config Files'): return 1;
    case t('其他文件', 'Other Files'): return 2;
    case t('全部', 'All'): return 0;
    default: return 99;
  }
}

export async function enrichMatches(rawMatches: RawSearchMatch[], options: TextSearchOptions): Promise<TextSearchMatch[]> {
  const grouped = new Map<string, RawSearchMatch[]>();
  for (const match of rawMatches) {
    const key = match.uri.toString();
    const bucket = grouped.get(key) ?? [];
    bucket.push(match);
    grouped.set(key, bucket);
  }

  const enriched: TextSearchMatch[] = [];
  for (const [uriKey, matches] of grouped.entries()) {
    const uri = vscode.Uri.parse(uriKey);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      for (const match of matches) {
        enriched.push({
          ...match,
          beforeLines: [],
          afterLines: [],
          contentKind: 'code',
          fileKind: 'code',
        });
      }
      continue;
    }

    const lines = Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
    const commentRangesByLine = buildCommentRangesByLine(lines, document.languageId);
    const fileKind = detectFileKind(document);
    for (const match of matches) {
      const context = buildContext(lines, match.lineNumber, options.beforeContextLines, options.afterContextLines);
      const commentRanges = commentRangesByLine[match.lineNumber - 1] ?? [];
      enriched.push({
        ...match,
        beforeLines: context.beforeLines,
        afterLines: context.afterLines,
        contentKind: detectContentKind(commentRanges, match.range),
        fileKind,
      });
    }
  }

  return enriched.sort((a, b) => {
    const fileCmp = a.relativePath.localeCompare(b.relativePath);
    if (fileCmp !== 0) return fileCmp;
    return a.lineNumber - b.lineNumber;
  });
}
