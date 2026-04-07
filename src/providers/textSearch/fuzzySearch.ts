import * as path from 'path';
import * as vscode from 'vscode';
import { TextSearchOptions, RawSearchMatch } from './types';
import { clamp, splitWorkspaceAndRelative, normalizeRelativePath, resolveCaseSensitive, shouldExcludeRelativePath } from './utils';
import { applyRgSearchFlags, runRgCommand } from './ripgrepRunner';

export function findSubsequenceRange(lineText: string, query: string, caseSensitive: boolean): { start: number; end: number } | undefined {
  if (!query) return undefined;
  const source = caseSensitive ? lineText : lineText.toLocaleLowerCase();
  const target = caseSensitive ? query : query.toLocaleLowerCase();
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

export function utf8ByteOffsetToUtf16Column(lineText: string, byteOffset: number): number {
  const buffer = Buffer.from(lineText, 'utf8');
  const clampedOffset = clamp(byteOffset, 0, buffer.length);
  return buffer.subarray(0, clampedOffset).toString('utf8').length;
}

export function findMatchRange(lineText: string, query: string, lineNumber: number, options: TextSearchOptions, matchStart?: number, matchEnd?: number): vscode.Range {
  if (typeof matchStart === 'number' && typeof matchEnd === 'number' && matchEnd > matchStart) {
    return new vscode.Range(lineNumber - 1, matchStart, lineNumber - 1, matchEnd);
  }

  const caseSensitive = resolveCaseSensitive(query, options);
  if (options.fuzzySearch) {
    const fuzzyRange = findSubsequenceRange(lineText, query, caseSensitive);
    if (fuzzyRange) return new vscode.Range(lineNumber - 1, fuzzyRange.start, lineNumber - 1, fuzzyRange.end);
  }

  const haystack = caseSensitive ? lineText : lineText.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const index = haystack.indexOf(needle);
  const start = index >= 0 ? index : 0;
  const end = index >= 0 ? index + query.length : Math.min(lineText.length, start + Math.max(query.length, 1));
  return new vscode.Range(lineNumber - 1, start, lineNumber - 1, end);
}

async function collectCandidateFiles(options: TextSearchOptions, token?: vscode.CancellationToken): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) throw new Error('No workspace folder is open');

  const args = ['--files'];
  applyRgSearchFlags(args, options);
  args.push(...folders.map(folder => folder.uri.fsPath));

  const stdout = await runRgCommand(args, token);
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

export function filterExcludedPaths<T extends RawSearchMatch | string>(
  items: T[],
  options: TextSearchOptions,
  mapItem: (item: T) => { relativePath: string; folderPath: string },
): T[] {
  if (options.excludeRules.length === 0) return items;
  const existsCache = new Map<string, boolean>();
  return items.filter(item => {
    const { relativePath, folderPath } = mapItem(item);
    return !shouldExcludeRelativePath(relativePath, folderPath, options.excludeRules, existsCache);
  });
}

export async function executeFuzzySearch(query: string, options: TextSearchOptions, token?: vscode.CancellationToken): Promise<{ matches: RawSearchMatch[]; warning?: string }> {
  const allFilePaths = await collectCandidateFiles(options, token);
  const filteredFilePaths = filterExcludedPaths(allFilePaths, options, filePath => {
    const workspaceInfo = splitWorkspaceAndRelative(filePath);
    return {
      relativePath: workspaceInfo?.relativePath ?? normalizeRelativePath(filePath),
      folderPath: workspaceInfo?.folder.uri.fsPath ?? path.dirname(filePath),
    };
  });

  let warning: string | undefined;
  const filePaths = filteredFilePaths.slice(0, options.maxFuzzyFileScan);
  if (filteredFilePaths.length > filePaths.length) {
    warning = `Fuzzy search scanned only the first ${filePaths.length} files. Increase smartReferences.textSearch.maxFuzzyFileScan if needed.`;
  }

  const caseSensitive = resolveCaseSensitive(query, options);
  const matches: RawSearchMatch[] = [];
  for (const filePath of filePaths) {
    if (token?.isCancellationRequested) throw new Error('Text search cancelled');
    const workspaceInfo = splitWorkspaceAndRelative(filePath);
    if (!workspaceInfo) continue;
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch {
      continue;
    }
    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      if (token?.isCancellationRequested) throw new Error('Text search cancelled');
      const lineText = document.lineAt(lineIndex).text;
      const fuzzyRange = findSubsequenceRange(lineText, query, caseSensitive);
      if (!fuzzyRange) continue;
      matches.push({
        workspaceName: workspaceInfo.folder.name,
        workspaceUri: workspaceInfo.folder.uri,
        uri: document.uri,
        relativePath: workspaceInfo.relativePath,
        lineNumber: lineIndex + 1,
        lineText,
        range: new vscode.Range(lineIndex, fuzzyRange.start, lineIndex, fuzzyRange.end),
      });
      if (matches.length >= options.maxFuzzyMatches) {
        warning = `Fuzzy search stopped after ${options.maxFuzzyMatches} matches. Increase smartReferences.textSearch.maxFuzzyMatches if needed.`;
        return { matches, warning };
      }
    }
  }

  return { matches, warning };
}
