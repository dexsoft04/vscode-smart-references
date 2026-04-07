import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExcludeConfigValue, TextSearchExcludeRule, TextSearchRequest } from './types';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function splitGlobList(value: string): string[] {
  const parts: string[] = [];
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

    if (ch === ',' && braceDepth == 0 && bracketDepth == 0 && parenDepth == 0) {
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

export function normalizeGlobs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return splitGlobList(value);
  }
  return [];
}

export function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function shortenTitlePart(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

export function summarizeGlobInput(globs: string): string | undefined {
  const parts = normalizeGlobs(globs);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return shortenTitlePart(parts[0], 18);
  return `${shortenTitlePart(parts[0], 14)} +${parts.length - 1}`;
}

export function buildTextSearchTitle(query: string, request: TextSearchRequest | undefined, warning?: string): string {
  if (!query) return 'Text Search';
  const parts: string[] = [];
  if (request?.fuzzySearch) parts.push('fuzzy');
  else if (request?.useRegExp) parts.push('regex');
  if (request?.matchCase) parts.push('case');
  if (request?.matchWholeWord && !request?.fuzzySearch) parts.push('word');
  const include = request ? summarizeGlobInput(request.include) : undefined;
  if (include) parts.push(`in:${include}`);
  const exclude = request ? summarizeGlobInput(request.exclude) : undefined;
  if (exclude) parts.push(`out:${exclude}`);
  if (warning) parts.push('limited');
  const suffix = parts.length > 0 ? ` [${parts.join(', ')}]` : '';
  return `Text Search: ${shortenTitlePart(query, 48)}${suffix}`;
}

export function readConfiguredContextLineCounts(config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('smartReferences')): { beforeContextLines: number; afterContextLines: number } {
  return {
    beforeContextLines: clamp(config.get<number>('textSearch.beforeContextLines', 2) ?? 2, 0, 20),
    afterContextLines: clamp(config.get<number>('textSearch.afterContextLines', 3) ?? 3, 0, 20),
  };
}

export function createDefaultSearchRequest(fuzzySearch: boolean, beforeContextLines: number, afterContextLines: number): TextSearchRequest {
  return {
    query: '',
    replaceText: '',
    include: '',
    exclude: '',
    useRegExp: false,
    matchCase: false,
    matchWholeWord: false,
    fuzzySearch,
    beforeContextLines,
    afterContextLines,
  };
}

export function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/');
  const regStr = normalized
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

export function normalizeRelativePath(fsPath: string): string {
  return fsPath.replace(/\\/g, '/');
}

export function collectExcludeRules(configValue: unknown): TextSearchExcludeRule[] {
  if (!configValue || typeof configValue !== 'object') return [];
  const rules: TextSearchExcludeRule[] = [];
  for (const [pattern, value] of Object.entries(configValue as Record<string, ExcludeConfigValue>)) {
    if (value === false) continue;
    const when = typeof value === 'object' && value && typeof value.when === 'string' && value.when.trim()
      ? value.when.trim()
      : undefined;
    rules.push({ pattern, regex: globToRegex(pattern), when });
  }
  return rules;
}

export function resolveWhenTarget(relativePath: string, when: string): string {
  const ext = path.posix.extname(relativePath);
  const baseWithoutExt = path.posix.basename(relativePath, ext);
  const relativeDir = path.posix.dirname(relativePath);
  const replaced = when.replace(/\$\(basename\)/g, baseWithoutExt);
  const joined = relativeDir === '.' ? replaced : path.posix.join(relativeDir, replaced);
  return normalizeRelativePath(path.posix.normalize(joined));
}

export function fileExists(fsPath: string, cache: Map<string, boolean>): boolean {
  const cached = cache.get(fsPath);
  if (typeof cached === 'boolean') return cached;
  const exists = fs.existsSync(fsPath);
  cache.set(fsPath, exists);
  return exists;
}

export function shouldExcludeRelativePath(relativePath: string, folderPath: string, rules: TextSearchExcludeRule[], existsCache: Map<string, boolean>): boolean {
  for (const rule of rules) {
    if (!rule.regex.test(relativePath)) continue;
    if (!rule.when) return true;
    const siblingRelativePath = resolveWhenTarget(relativePath, rule.when);
    const siblingFsPath = path.join(folderPath, siblingRelativePath);
    if (fileExists(siblingFsPath, existsCache)) return true;
  }
  return false;
}

export function splitWorkspaceAndRelative(filePath: string): { folder: vscode.WorkspaceFolder; relativePath: string } | undefined {
  const uri = vscode.Uri.file(filePath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const relativePath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');
  return { folder, relativePath };
}

export function resolveCaseSensitive(query: string, options: { matchCase: boolean; smartCase: boolean }): boolean {
  return options.matchCase || (options.smartCase && /[A-Z]/.test(query));
}
