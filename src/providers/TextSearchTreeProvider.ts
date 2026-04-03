import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { isStructuredTextLanguage } from '../core/StructuredTextParser';
import { t } from '../i18n';

export type SearchNode = SectionNode | WorkspaceNode | FileNode | MatchNode | ContextLineNode;
type TextSearchContentKind = 'code' | 'comment';
type TextSearchFileKind = 'code' | 'config';
type ExcludeConfigValue = boolean | { when?: string };
type CommentSyntax = 'slash' | 'hash' | 'dashdash' | 'xml' | 'semicolon';

export type TextSearchGroupingMode = 'none' | 'content' | 'fileKind' | 'both';

export interface TextSearchRequest {
  readonly query: string;
  readonly replaceText: string;
  readonly include: string;
  readonly exclude: string;
  readonly useRegExp: boolean;
  readonly matchCase: boolean;
  readonly matchWholeWord: boolean;
  readonly fuzzySearch: boolean;
  readonly beforeContextLines: number;
  readonly afterContextLines: number;
}


export interface TextSearchLineState {
  readonly lineNumber: number;
  readonly text: string;
}

export interface TextSearchMatchState {
  readonly key: string;
  readonly uri: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly matchedText: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
  readonly beforeLines: TextSearchLineState[];
  readonly afterLines: TextSearchLineState[];
  readonly contentKind: TextSearchContentKind;
}

export interface TextSearchFileState {
  readonly key: string;
  readonly workspaceName: string;
  readonly uri: string;
  readonly relativePath: string;
  readonly matchCount: number;
  readonly fileKind: TextSearchFileKind;
  readonly matches: TextSearchMatchState[];
}

export interface TextSearchSectionState {
  readonly key: string;
  readonly label: string;
  readonly matchCount: number;
  readonly fileCount: number;
  readonly files: TextSearchFileState[];
}

export interface TextSearchViewState {
  readonly title: string;
  readonly request?: TextSearchRequest;
  readonly warning?: string;
  readonly groupingMode: TextSearchGroupingMode;
  readonly totalMatches: number;
  readonly totalFiles: number;
  readonly sections: TextSearchSectionState[];
}

export interface TextSearchReplaceTarget {
  readonly key: string;
  readonly uri: string;
  readonly sectionKey: string;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly matchedText: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

interface TextSearchContextLine {
  readonly lineNumber: number;
  readonly text: string;
}

interface TextSearchExcludeRule {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly when?: string;
}

interface TextSearchMatch {
  readonly workspaceName: string;
  readonly workspaceUri: vscode.Uri;
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly range: vscode.Range;
  readonly beforeLines: TextSearchContextLine[];
  readonly afterLines: TextSearchContextLine[];
  readonly contentKind: TextSearchContentKind;
  readonly fileKind: TextSearchFileKind;
}

interface TextSearchOptions {
  readonly beforeContextLines: number;
  readonly afterContextLines: number;
  readonly includeGlobs: string[];
  readonly excludeGlobs: string[];
  readonly excludeRules: TextSearchExcludeRule[];
  readonly fuzzySearch: boolean;
  readonly useRegExp: boolean;
  readonly matchCase: boolean;
  readonly matchWholeWord: boolean;
  readonly smartCase: boolean;
  readonly groupCodeAndComments: boolean;
  readonly groupConfigAndCodeFiles: boolean;
  readonly useIgnoreFiles: boolean;
  readonly useGlobalIgnoreFiles: boolean;
  readonly useParentIgnoreFiles: boolean;
  readonly followSymlinks: boolean;
  readonly maxFuzzyFileScan: number;
  readonly maxFuzzyMatches: number;
}

interface RawSearchMatch {
  readonly workspaceName: string;
  readonly workspaceUri: vscode.Uri;
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly range: vscode.Range;
}

interface WorkspaceBucket {
  readonly folder: vscode.WorkspaceFolder;
  readonly matches: TextSearchMatch[];
}

interface SectionBucket {
  readonly key: string;
  readonly label: string;
  readonly matches: TextSearchMatch[];
}

interface FileBucket {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly matches: TextSearchMatch[];
}

interface RgSubmatch {
  start?: number;
  end?: number;
}

interface RgJsonMessage {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: RgSubmatch[];
  };
}

interface CommentRangesForLine {
  readonly ranges: Array<{ start: number; end: number }>;
  readonly nextInBlockComment: boolean;
}

const CONFIG_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'cargo.toml', 'cargo.lock', 'pyproject.toml', 'requirements.txt', 'pipfile', 'pipfile.lock',
  'poetry.lock', 'setup.py', 'setup.cfg', 'go.mod', 'go.sum', 'makefile', 'cmakelists.txt',
  '.editorconfig', '.gitignore', '.gitattributes', '.npmrc', '.yarnrc', '.yarnrc.yml', '.prettierrc',
  '.prettierrc.json', '.prettierrc.yaml', '.eslintrc', '.eslintrc.json', '.eslintrc.yaml',
  'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.env', '.env.local', '.env.test',
  '.env.production', 'pubspec.yaml', 'pubspec.lock', 'gradle.properties', 'settings.gradle',
]);

const CONFIG_EXTENSIONS = new Set([
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.properties', '.env', '.conf', '.config',
  '.xml', '.editorconfig', '.gitignore', '.gitattributes', '.lock',
]);

class SectionNode extends vscode.TreeItem {
  constructor(public readonly bucket: SectionBucket) {
    super(bucket.label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${bucket.matches.length}`;
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.contextValue = 'textSearchSection';
  }
}

class WorkspaceNode extends vscode.TreeItem {
  constructor(public readonly bucket: WorkspaceBucket) {
    super(bucket.folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${bucket.matches.length}`;
    this.tooltip = bucket.folder.uri.fsPath;
    this.iconPath = new vscode.ThemeIcon('root-folder');
    this.contextValue = 'textSearchWorkspace';
  }
}

class FileNode extends vscode.TreeItem {
  constructor(public readonly bucket: FileBucket) {
    super(bucket.relativePath, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${bucket.matches.length}`;
    this.tooltip = bucket.uri.fsPath;
    this.resourceUri = bucket.uri;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = 'textSearchFile';
  }
}

class MatchNode extends vscode.TreeItem {
  constructor(public readonly match: TextSearchMatch) {
    super(buildMatchTreeItemLabel(match), buildContextCollapsibleState(match));
    this.description = `${match.lineNumber}`;
    this.tooltip = buildMatchTooltip(match);
    this.resourceUri = match.uri;
    this.iconPath = new vscode.ThemeIcon(match.contentKind === 'comment' ? 'comment' : 'search');
    this.command = {
      command: 'smartReferences.previewReference',
      title: t('预览搜索命中', 'Preview Search Match'),
      arguments: [match.uri, match.range],
    };
    this.contextValue = 'textSearchMatch';
  }
}

class ContextLineNode extends vscode.TreeItem {
  constructor(public readonly match: TextSearchMatch, public readonly line: TextSearchContextLine, role: 'before' | 'current' | 'after') {
    super(role === 'current' ? buildMatchTreeItemLabel(match) : { label: line.text || t('(空行)', '(blank line)') }, vscode.TreeItemCollapsibleState.None);
    this.description = `${line.lineNumber}`;
    this.resourceUri = match.uri;
    this.iconPath = new vscode.ThemeIcon(
      role === 'before' ? 'arrow-up' : role === 'after' ? 'arrow-down' : 'search',
    );
    this.command = {
      command: 'smartReferences.previewReference',
      title: role === 'current' ? t('预览搜索命中', 'Preview Search Match') : t('预览搜索上下文', 'Preview Search Context'),
      arguments: [
        match.uri,
        role === 'current'
          ? match.range
          : new vscode.Range(line.lineNumber - 1, 0, line.lineNumber - 1, Math.max(line.text.length, 1)),
      ],
    };
    this.contextValue = role === 'current' ? 'textSearchContextCurrent' : 'textSearchContext';
  }
}

function buildMatchTreeItemLabel(match: TextSearchMatch): vscode.TreeItemLabel {
  const label = match.lineText || t('(空行)', '(blank line)');
  const start = clamp(match.range.start.character, 0, label.length);
  const end = clamp(match.range.end.character, start, label.length);
  return {
    label,
    highlights: start === end ? undefined : [[start, end]],
  };
}

function buildContextCollapsibleState(match: TextSearchMatch): vscode.TreeItemCollapsibleState {
  return match.beforeLines.length > 0 || match.afterLines.length > 0
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
}

function buildMatchTooltip(match: TextSearchMatch): vscode.MarkdownString {
  const snippet = [
    ...match.beforeLines.map(line => `${String(line.lineNumber).padStart(5)}   ${line.text}`),
    `${String(match.lineNumber).padStart(5)} → ${match.lineText}`,
    ...match.afterLines.map(line => `${String(line.lineNumber).padStart(5)}   ${line.text}`),
  ].join('\n');
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${match.relativePath}:${match.lineNumber}**\n\n`);
  md.appendCodeblock(snippet || `${match.lineNumber}`, 'plaintext');
  return md;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function splitGlobList(value: string): string[] {
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

function normalizeGlobs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return splitGlobList(value);
  }
  return [];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function shortenTitlePart(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function summarizeGlobInput(globs: string): string | undefined {
  const parts = normalizeGlobs(globs);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return shortenTitlePart(parts[0], 18);
  return `${shortenTitlePart(parts[0], 14)} +${parts.length - 1}`;
}

function buildTextSearchTitle(query: string, request: TextSearchRequest | undefined, warning?: string): string {
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

function readConfiguredContextLineCounts(config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('smartReferences')): { beforeContextLines: number; afterContextLines: number } {
  return {
    beforeContextLines: clamp(config.get<number>('textSearch.beforeContextLines', 2) ?? 2, 0, 20),
    afterContextLines: clamp(config.get<number>('textSearch.afterContextLines', 3) ?? 3, 0, 20),
  };
}

function createDefaultSearchRequest(fuzzySearch: boolean, beforeContextLines: number, afterContextLines: number): TextSearchRequest {
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

function globToRegex(pattern: string): RegExp {
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

function normalizeRelativePath(fsPath: string): string {
  return fsPath.replace(/\\/g, '/');
}

function collectExcludeRules(configValue: unknown): TextSearchExcludeRule[] {
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

function resolveWhenTarget(relativePath: string, when: string): string {
  const ext = path.posix.extname(relativePath);
  const baseWithoutExt = path.posix.basename(relativePath, ext);
  const relativeDir = path.posix.dirname(relativePath);
  const replaced = when.replace(/\$\(basename\)/g, baseWithoutExt);
  const joined = relativeDir === '.' ? replaced : path.posix.join(relativeDir, replaced);
  return normalizeRelativePath(path.posix.normalize(joined));
}

function fileExists(fsPath: string, cache: Map<string, boolean>): boolean {
  const cached = cache.get(fsPath);
  if (typeof cached === 'boolean') return cached;
  const exists = fs.existsSync(fsPath);
  cache.set(fsPath, exists);
  return exists;
}

function shouldExcludeRelativePath(relativePath: string, folderPath: string, rules: TextSearchExcludeRule[], existsCache: Map<string, boolean>): boolean {
  for (const rule of rules) {
    if (!rule.regex.test(relativePath)) continue;
    if (!rule.when) return true;
    const siblingRelativePath = resolveWhenTarget(relativePath, rule.when);
    const siblingFsPath = path.join(folderPath, siblingRelativePath);
    if (fileExists(siblingFsPath, existsCache)) return true;
  }
  return false;
}

function splitWorkspaceAndRelative(filePath: string): { folder: vscode.WorkspaceFolder; relativePath: string } | undefined {
  const uri = vscode.Uri.file(filePath);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const relativePath = path.relative(folder.uri.fsPath, filePath).replace(/\\/g, '/');
  return { folder, relativePath };
}

function resolveCaseSensitive(query: string, options: TextSearchOptions): boolean {
  return options.matchCase || (options.smartCase && /[A-Z]/.test(query));
}

function findSubsequenceRange(lineText: string, query: string, caseSensitive: boolean): { start: number; end: number } | undefined {
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

function utf8ByteOffsetToUtf16Column(lineText: string, byteOffset: number): number {
  const buffer = Buffer.from(lineText, 'utf8');
  const clampedOffset = clamp(byteOffset, 0, buffer.length);
  return buffer.subarray(0, clampedOffset).toString('utf8').length;
}

function findMatchRange(lineText: string, query: string, lineNumber: number, options: TextSearchOptions, matchStart?: number, matchEnd?: number): vscode.Range {
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

function applyRgSearchFlags(args: string[], options: TextSearchOptions): void {
  if (!options.useIgnoreFiles) {
    args.push('--no-ignore');
  } else {
    if (!options.useGlobalIgnoreFiles) args.push('--no-ignore-global');
    if (!options.useParentIgnoreFiles) args.push('--no-ignore-parent');
  }
  if (!options.followSymlinks) args.push('--no-follow');
  for (const glob of options.includeGlobs) {
    args.push('--glob', glob);
  }
  for (const glob of options.excludeGlobs) {
    args.push('--glob', `!${glob}`);
  }
}

function applySearchModeFlags(args: string[], query: string, options: TextSearchOptions): void {
  if (!options.useRegExp) {
    args.push('--fixed-strings');
  }
  if (options.matchWholeWord) {
    args.push('--word-regexp');
  }
  if (options.matchCase) {
    args.push('--case-sensitive');
    return;
  }
  if (options.smartCase && /[A-Z]/.test(query)) {
    args.push('--smart-case');
    return;
  }
  args.push('--ignore-case');
}

async function runRgCommand(args: string[], token?: vscode.CancellationToken): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let cancelDisposable: vscode.Disposable | undefined;

    const finalizeReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cancelDisposable?.dispose();
      reject(err);
    };
    const finalizeResolve = (value: string) => {
      if (settled) return;
      settled = true;
      cancelDisposable?.dispose();
      resolve(value);
    };

    if (token) {
      cancelDisposable = token.onCancellationRequested(() => {
        cancelled = true;
        child.kill();
      });
    }

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => finalizeReject(err instanceof Error ? err : new Error(String(err))));
    child.on('close', code => {
      if (cancelled || token?.isCancellationRequested) {
        finalizeReject(new Error('Text search cancelled'));
        return;
      }
      if (code !== 0 && code !== 1) {
        finalizeReject(new Error(stderr.trim() || `rg exited with code ${code}`));
        return;
      }
      finalizeResolve(stdout);
    });
  });
}

function parseRgOutput(rawOutput: string, query: string, options: TextSearchOptions): RawSearchMatch[] {
  const matches: RawSearchMatch[] = [];
  const lines = rawOutput.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    let message: RgJsonMessage;
    try {
      message = JSON.parse(line) as RgJsonMessage;
    } catch {
      continue;
    }
    if (message.type !== 'match' || !message.data?.path?.text || !message.data?.lines?.text || !message.data.line_number) {
      continue;
    }
    const filePath = message.data.path.text;
    const workspaceInfo = splitWorkspaceAndRelative(filePath);
    if (!workspaceInfo) continue;
    const lineText = message.data.lines.text.replace(/\r?\n$/, '');
    const submatch = message.data.submatches?.[0];
    const matchStart = typeof submatch?.start === 'number'
      ? utf8ByteOffsetToUtf16Column(lineText, submatch.start)
      : undefined;
    const matchEnd = typeof submatch?.end === 'number'
      ? utf8ByteOffsetToUtf16Column(lineText, submatch.end)
      : undefined;
    matches.push({
      workspaceName: workspaceInfo.folder.name,
      workspaceUri: workspaceInfo.folder.uri,
      uri: vscode.Uri.file(filePath),
      relativePath: workspaceInfo.relativePath,
      lineNumber: message.data.line_number,
      lineText,
      range: findMatchRange(lineText, query, message.data.line_number, options, matchStart, matchEnd),
    });
  }
  return matches;
}

async function executeFixedRgSearch(query: string, options: TextSearchOptions, token?: vscode.CancellationToken): Promise<RawSearchMatch[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) throw new Error('No workspace folder is open');

  const args = ['--json', '--line-number'];
  applySearchModeFlags(args, query, options);
  applyRgSearchFlags(args, options);
  args.push(query, ...folders.map(folder => folder.uri.fsPath));

  const stdout = await runRgCommand(args, token);
  return parseRgOutput(stdout, query, options);
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

function filterExcludedPaths<T extends RawSearchMatch | string>(
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

async function executeFuzzySearch(query: string, options: TextSearchOptions, token?: vscode.CancellationToken): Promise<{ matches: RawSearchMatch[]; warning?: string }> {
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

function detectFileKind(document: vscode.TextDocument): TextSearchFileKind {
  const base = path.basename(document.uri.fsPath).toLowerCase();
  if (CONFIG_BASENAMES.has(base)) return 'config';
  const ext = path.extname(base);
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  if (isStructuredTextLanguage(document.languageId) && !['markdown', 'html', 'xml'].includes(document.languageId)) {
    return 'config';
  }
  return 'code';
}

function getCommentSyntax(languageId: string): CommentSyntax {
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

function analyzeCommentRanges(lineText: string, syntax: CommentSyntax, inBlockComment: boolean): CommentRangesForLine {
  const ranges: Array<{ start: number; end: number }> = [];
  const blockTokens = syntax === 'slash'
    ? { start: '/*', end: '*/' }
    : syntax === 'xml'
      ? { start: '<!--', end: '-->' }
      : undefined;
  const lineToken = syntax === 'slash'
    ? '//'
    : syntax === 'hash'
      ? '#'
      : syntax === 'dashdash'
        ? '--'
        : syntax === 'semicolon'
          ? ';'
          : undefined;

  let cursor = 0;
  let blockOpen = inBlockComment;
  while (cursor < lineText.length) {
    if (blockOpen && blockTokens) {
      const closeIndex = lineText.indexOf(blockTokens.end, cursor);
      if (closeIndex === -1) {
        ranges.push({ start: cursor, end: lineText.length });
        return { ranges, nextInBlockComment: true };
      }
      ranges.push({ start: cursor, end: closeIndex + blockTokens.end.length });
      cursor = closeIndex + blockTokens.end.length;
      blockOpen = false;
      continue;
    }

    let inSingle = false;
    let inDouble = false;
    let inBacktick = false;
    let escaped = false;
    let foundComment = false;

    for (let index = cursor; index < lineText.length; index++) {
      const ch = lineText[index];
      const next = lineText[index + 1] ?? '';

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

      if (blockTokens && lineText.startsWith(blockTokens.start, index)) {
        const closeIndex = lineText.indexOf(blockTokens.end, index + blockTokens.start.length);
        if (closeIndex === -1) {
          ranges.push({ start: index, end: lineText.length });
          return { ranges, nextInBlockComment: true };
        }
        ranges.push({ start: index, end: closeIndex + blockTokens.end.length });
        cursor = closeIndex + blockTokens.end.length;
        foundComment = true;
        break;
      }
      if (lineToken && lineText.startsWith(lineToken, index)) {
        ranges.push({ start: index, end: lineText.length });
        return { ranges, nextInBlockComment: false };
      }
    }

    if (!foundComment) {
      return { ranges, nextInBlockComment: false };
    }
  }

  return { ranges, nextInBlockComment: false };
}

function buildCommentRangesByLine(lines: string[], languageId: string): Array<Array<{ start: number; end: number }>> {
  const syntax = getCommentSyntax(languageId);
  let inBlockComment = false;
  return lines.map(line => {
    const analyzed = analyzeCommentRanges(line, syntax, inBlockComment);
    inBlockComment = analyzed.nextInBlockComment;
    return analyzed.ranges;
  });
}

function detectContentKind(commentRanges: Array<{ start: number; end: number }>, matchRange: vscode.Range): TextSearchContentKind {
  return commentRanges.some(range => matchRange.start.character >= range.start && matchRange.start.character < range.end)
    ? 'comment'
    : 'code';
}

function buildContext(lines: string[], lineNumber: number, beforeCount: number, afterCount: number): { beforeLines: TextSearchContextLine[]; afterLines: TextSearchContextLine[] } {
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

function buildSectionLabel(match: TextSearchMatch, options: TextSearchOptions): string {
  const parts: string[] = [];
  if (options.groupCodeAndComments) parts.push(match.contentKind === 'comment' ? t('注释', 'Comments') : t('代码', 'Code'));
  if (options.groupConfigAndCodeFiles) parts.push(match.fileKind === 'config' ? t('配置文件', 'Config Files') : t('代码文件', 'Code Files'));
  return parts.join(' · ') || t('全部', 'All');
}

function getSectionSortOrder(label: string): number {
  switch (label) {
    case t('代码 · 代码文件', 'Code · Code Files'): return 0;
    case t('注释 · 代码文件', 'Comments · Code Files'): return 1;
    case t('代码 · 配置文件', 'Code · Config Files'): return 2;
    case t('注释 · 配置文件', 'Comments · Config Files'): return 3;
    case t('代码', 'Code'): return 0;
    case t('注释', 'Comments'): return 1;
    case t('代码文件', 'Code Files'): return 0;
    case t('配置文件', 'Config Files'): return 1;
    case t('全部', 'All'): return 0;
    default: return 99;
  }
}

async function enrichMatches(rawMatches: RawSearchMatch[], options: TextSearchOptions): Promise<TextSearchMatch[]> {
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

function groupMatchesByWorkspace(matches: TextSearchMatch[]): WorkspaceBucket[] {
  const buckets = new Map<string, WorkspaceBucket>();
  for (const match of matches) {
    const key = match.workspaceUri.toString();
    const folder = vscode.workspace.getWorkspaceFolder(match.workspaceUri) ?? {
      uri: match.workspaceUri,
      name: match.workspaceName,
      index: 0,
    };
    const bucket = buckets.get(key) ?? { folder, matches: [] };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.folder.name.localeCompare(b.folder.name));
}

function groupMatchesByFile(matches: TextSearchMatch[]): FileBucket[] {
  const buckets = new Map<string, FileBucket>();
  for (const match of matches) {
    const key = match.uri.toString();
    const bucket = buckets.get(key) ?? {
      uri: match.uri,
      relativePath: match.relativePath,
      matches: [],
    };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => {
    const diff = b.matches.length - a.matches.length;
    if (diff !== 0) return diff;
    return a.relativePath.localeCompare(b.relativePath);
  });
}



function serializeLine(line: TextSearchContextLine): TextSearchLineState {
  return {
    lineNumber: line.lineNumber,
    text: line.text,
  };
}

function buildMatchKey(match: TextSearchMatch): string {
  return `${match.uri.toString()}#${match.range.start.line}:${match.range.start.character}-${match.range.end.line}:${match.range.end.character}`;
}

function extractMatchedText(match: TextSearchMatch): string {
  if (match.range.start.line !== match.range.end.line) return '';
  return match.lineText.slice(match.range.start.character, match.range.end.character);
}

function serializeMatch(match: TextSearchMatch): TextSearchMatchState {
  return {
    key: buildMatchKey(match),
    uri: match.uri.toString(),
    lineNumber: match.lineNumber,
    lineText: match.lineText,
    matchedText: extractMatchedText(match),
    startLine: match.range.start.line,
    startCharacter: match.range.start.character,
    endLine: match.range.end.line,
    endCharacter: match.range.end.character,
    beforeLines: match.beforeLines.map(serializeLine),
    afterLines: match.afterLines.map(serializeLine),
    contentKind: match.contentKind,
  };
}

function serializeFileBucket(bucket: FileBucket): TextSearchFileState {
  return {
    key: bucket.uri.toString(),
    workspaceName: bucket.matches[0]?.workspaceName ?? '',
    uri: bucket.uri.toString(),
    relativePath: bucket.relativePath,
    matchCount: bucket.matches.length,
    fileKind: bucket.matches[0]?.fileKind ?? 'code',
    matches: bucket.matches
      .slice()
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map(serializeMatch),
  };
}

function buildSerializedSections(matches: TextSearchMatch[], options: TextSearchOptions): TextSearchSectionState[] {
  const sectionBuckets = buildSectionBuckets(matches, options);
  if (sectionBuckets.length > 0) {
    return sectionBuckets.map(bucket => {
      const files = groupMatchesByFile(bucket.matches).map(serializeFileBucket);
      return {
        key: bucket.key,
        label: bucket.label,
        matchCount: bucket.matches.length,
        fileCount: files.length,
        files,
      };
    });
  }

  const workspaces = groupMatchesByWorkspace(matches);
  if (workspaces.length <= 1) {
    const files = workspaces.length === 1
      ? groupMatchesByFile(workspaces[0].matches).map(serializeFileBucket)
      : groupMatchesByFile(matches).map(serializeFileBucket);
    return [{
      key: 'all',
      label: '',
      matchCount: matches.length,
      fileCount: files.length,
      files,
    }];
  }

  return workspaces.map(bucket => {
    const files = groupMatchesByFile(bucket.matches).map(serializeFileBucket);
    return {
      key: bucket.folder.uri.toString(),
      label: bucket.folder.name,
      matchCount: bucket.matches.length,
      fileCount: files.length,
      files,
    };
  });
}

function buildSectionBuckets(matches: TextSearchMatch[], options: TextSearchOptions): SectionBucket[] {
  if (!options.groupCodeAndComments && !options.groupConfigAndCodeFiles) return [];
  const buckets = new Map<string, SectionBucket>();
  for (const match of matches) {
    const key = buildSectionLabel(match, options);
    const bucket = buckets.get(key) ?? { key, label: key, matches: [] };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => {
    const order = getSectionSortOrder(a.label) - getSectionSortOrder(b.label);
    if (order !== 0) return order;
    return a.label.localeCompare(b.label);
  });
}


function loadTextSearchOptions(request: TextSearchRequest | undefined, groupingOverride?: { groupCodeAndComments: boolean; groupConfigAndCodeFiles: boolean }): TextSearchOptions {
  const config = vscode.workspace.getConfiguration('smartReferences');
  const searchConfig = vscode.workspace.getConfiguration('search');
  const filesConfig = vscode.workspace.getConfiguration('files');
  const configuredContextLines = readConfiguredContextLineCounts(config);
  const runtimeRequest = request ?? createDefaultSearchRequest(
    config.get<boolean>('textSearch.fuzzySearch', false) ?? false,
    configuredContextLines.beforeContextLines,
    configuredContextLines.afterContextLines,
  );

  const searchExcludeRules = collectExcludeRules(searchConfig.get('exclude'));
  const filesExcludeRules = collectExcludeRules(filesConfig.get('exclude'));
  const customExcludeRules: TextSearchExcludeRule[] = normalizeGlobs(config.get('textSearch.excludeGlobs', [])).map(pattern => ({
    pattern,
    regex: globToRegex(pattern),
    when: undefined,
  }));
  const runtimeExcludeRules: TextSearchExcludeRule[] = normalizeGlobs(runtimeRequest.exclude).map(pattern => ({
    pattern,
    regex: globToRegex(pattern),
    when: undefined,
  }));
  const excludeRules = [...searchExcludeRules, ...filesExcludeRules, ...customExcludeRules, ...runtimeExcludeRules];

  return {
    beforeContextLines: clamp(runtimeRequest.beforeContextLines, 0, 20),
    afterContextLines: clamp(runtimeRequest.afterContextLines, 0, 20),
    includeGlobs: dedupeStrings([
      ...normalizeGlobs(config.get('textSearch.includeGlobs', [])),
      ...normalizeGlobs(runtimeRequest.include),
    ]),
    excludeGlobs: dedupeStrings(excludeRules.filter(rule => !rule.when).map(rule => rule.pattern)),
    excludeRules,
    fuzzySearch: runtimeRequest.fuzzySearch,
    useRegExp: runtimeRequest.useRegExp,
    matchCase: runtimeRequest.matchCase,
    matchWholeWord: runtimeRequest.matchWholeWord,
    smartCase: searchConfig.get<boolean>('smartCase', false) ?? false,
    groupCodeAndComments: groupingOverride?.groupCodeAndComments ?? (config.get<boolean>('textSearch.groupCodeAndComments', false) ?? false),
    groupConfigAndCodeFiles: groupingOverride?.groupConfigAndCodeFiles ?? (config.get<boolean>('textSearch.groupConfigAndCodeFiles', false) ?? false),
    useIgnoreFiles: searchConfig.get<boolean>('useIgnoreFiles', true) ?? true,
    useGlobalIgnoreFiles: searchConfig.get<boolean>('useGlobalIgnoreFiles', true) ?? true,
    useParentIgnoreFiles: searchConfig.get<boolean>('useParentIgnoreFiles', true) ?? true,
    followSymlinks: searchConfig.get<boolean>('followSymlinks', true) ?? true,
    maxFuzzyFileScan: clamp(config.get<number>('textSearch.maxFuzzyFileScan', 2000) ?? 2000, 100, 20000),
    maxFuzzyMatches: clamp(config.get<number>('textSearch.maxFuzzyMatches', 1000) ?? 1000, 50, 20000),
  };
}

async function executeSearch(query: string, options: TextSearchOptions, token?: vscode.CancellationToken): Promise<{ matches: TextSearchMatch[]; warning?: string }> {
  if (options.fuzzySearch) {
    const fuzzy = await executeFuzzySearch(query, options, token);
    return {
      matches: await enrichMatches(fuzzy.matches, options),
      warning: fuzzy.warning,
    };
  }

  const rawMatches = await executeFixedRgSearch(query, options, token);
  const filteredMatches = filterExcludedPaths(rawMatches, options, match => ({
    relativePath: match.relativePath,
    folderPath: match.workspaceUri.fsPath,
  }));
  return {
    matches: await enrichMatches(filteredMatches, options),
  };
}

function buildReplaceTarget(match: TextSearchMatch): TextSearchReplaceTarget {
  return {
    key: buildMatchKey(match),
    uri: match.uri.toString(),
    sectionKey: '',
    relativePath: match.relativePath,
    lineNumber: match.lineNumber,
    matchedText: extractMatchedText(match),
    startLine: match.range.start.line,
    startCharacter: match.range.start.character,
    endLine: match.range.end.line,
    endCharacter: match.range.end.character,
  };
}

export class TextSearchTreeProvider implements vscode.TreeDataProvider<SearchNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<SearchNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private query = '';
  private request: TextSearchRequest | undefined;
  private matches: TextSearchMatch[] = [];
  private options = loadTextSearchOptions(undefined);
  private groupingOverride?: { groupCodeAndComments: boolean; groupConfigAndCodeFiles: boolean };
  private lastWarning?: string;
  private activeSearchTokenSource?: vscode.CancellationTokenSource;
  private activeSearchRunId = 0;

  getTreeItem(element: SearchNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SearchNode): Promise<SearchNode[]> {
    if (!element) {
      const sections = buildSectionBuckets(this.matches, this.options);
      if (sections.length > 0) return sections.map(bucket => new SectionNode(bucket));
      return this.buildWorkspaceOrFileNodes(this.matches);
    }
    if (element instanceof SectionNode) {
      return this.buildWorkspaceOrFileNodes(element.bucket.matches);
    }
    if (element instanceof WorkspaceNode) {
      return groupMatchesByFile(element.bucket.matches).map(bucket => new FileNode(bucket));
    }
    if (element instanceof FileNode) {
      return element.bucket.matches
        .slice()
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map(match => new MatchNode(match));
    }
    if (element instanceof MatchNode) {
      return [
        ...element.match.beforeLines.map(line => new ContextLineNode(element.match, line, 'before')),
        new ContextLineNode(
          element.match,
          { lineNumber: element.match.lineNumber, text: element.match.lineText },
          'current',
        ),
        ...element.match.afterLines.map(line => new ContextLineNode(element.match, line, 'after')),
      ];
    }
    return [];
  }

  private buildWorkspaceOrFileNodes(matches: TextSearchMatch[]): SearchNode[] {
    const workspaces = groupMatchesByWorkspace(matches);
    if (workspaces.length === 1) {
      return groupMatchesByFile(workspaces[0].matches).map(bucket => new FileNode(bucket));
    }
    return workspaces.map(bucket => new WorkspaceNode(bucket));
  }

  getTitle(): string {
    return buildTextSearchTitle(this.query, this.request, this.lastWarning);
  }

  hasResults(): boolean {
    return this.matches.length > 0;
  }

  getQuery(): string {
    return this.query;
  }

  getSearchRequest(): TextSearchRequest | undefined {
    return this.request;
  }

  getEditableRequest(): TextSearchRequest {
    const current = this.request ?? createDefaultSearchRequest(
      this.options.fuzzySearch,
      this.options.beforeContextLines,
      this.options.afterContextLines,
    );
    return { ...current };
  }

  getOrderedReplaceTargets(filters?: { targetKey?: string; sectionKey?: string; fileUri?: string }): TextSearchReplaceTarget[] {
    const sections = buildSerializedSections(this.matches, this.options);
    const targets = sections.flatMap(section => section.files.flatMap(file => file.matches.map(match => ({
      key: match.key,
      uri: match.uri,
      sectionKey: section.key,
      relativePath: file.relativePath,
      lineNumber: match.lineNumber,
      matchedText: match.matchedText,
      startLine: match.startLine,
      startCharacter: match.startCharacter,
      endLine: match.endLine,
      endCharacter: match.endCharacter,
    }))));
    return targets.filter(target => {
      if (filters?.targetKey && target.key !== filters.targetKey) return false;
      if (filters?.sectionKey && target.sectionKey !== filters.sectionKey) return false;
      if (filters?.fileUri && target.uri !== filters.fileUri) return false;
      return true;
    });
  }

  isFuzzySearchEnabled(): boolean {
    return this.options.fuzzySearch;
  }

  getLastWarning(): string | undefined {
    return this.lastWarning;
  }

  getViewState(): TextSearchViewState {
    const sections = buildSerializedSections(this.matches, this.options);
    const totalFiles = sections.reduce((sum, section) => sum + section.fileCount, 0);
    return {
      title: this.getTitle(),
      request: this.request ?? createDefaultSearchRequest(this.options.fuzzySearch, this.options.beforeContextLines, this.options.afterContextLines),
      warning: this.lastWarning,
      groupingMode: this.getGroupingMode(),
      totalMatches: this.matches.length,
      totalFiles,
      sections,
    };
  }

  getGroupingMode(): TextSearchGroupingMode {
    if (this.options.groupCodeAndComments && this.options.groupConfigAndCodeFiles) return 'both';
    if (this.options.groupCodeAndComments) return 'content';
    if (this.options.groupConfigAndCodeFiles) return 'fileKind';
    return 'none';
  }

  setGroupingMode(mode: TextSearchGroupingMode): void {
    this.groupingOverride = mode === 'none'
      ? { groupCodeAndComments: false, groupConfigAndCodeFiles: false }
      : mode === 'content'
        ? { groupCodeAndComments: true, groupConfigAndCodeFiles: false }
        : mode === 'fileKind'
          ? { groupCodeAndComments: false, groupConfigAndCodeFiles: true }
          : { groupCodeAndComments: true, groupConfigAndCodeFiles: true };
    this.options = loadTextSearchOptions(this.request, this.groupingOverride);
    this.onDidChangeTreeDataEmitter.fire();
  }

  clear(): void {
    this.cancelActiveSearch();
    this.query = '';
    this.request = undefined;
    this.matches = [];
    this.lastWarning = undefined;
    this.options = loadTextSearchOptions(undefined, this.groupingOverride);
    this.onDidChangeTreeDataEmitter.fire();
  }

  private beginSearch(token?: vscode.CancellationToken): {
    runId: number;
    token: vscode.CancellationToken;
    dispose: () => void;
  } {
    this.cancelActiveSearch();
    const source = new vscode.CancellationTokenSource();
    this.activeSearchTokenSource = source;
    const runId = ++this.activeSearchRunId;
    const forwardExternalCancellation = token?.onCancellationRequested(() => source.cancel());
    if (token?.isCancellationRequested) source.cancel();

    return {
      runId,
      token: source.token,
      dispose: () => {
        forwardExternalCancellation?.dispose();
        if (this.activeSearchTokenSource === source) this.activeSearchTokenSource = undefined;
        source.dispose();
      },
    };
  }

  private cancelActiveSearch(): void {
    this.activeSearchTokenSource?.cancel();
    this.activeSearchTokenSource?.dispose();
    this.activeSearchTokenSource = undefined;
  }

  private isSearchCancelled(err: unknown): boolean {
    return String(err) === 'Error: Text search cancelled' || String(err) === 'Text search cancelled';
  }

  async search(request: TextSearchRequest, token?: vscode.CancellationToken): Promise<boolean> {
    const normalizedQuery = request.query.trim();
    const normalizedRequest: TextSearchRequest = {
      ...request,
      query: normalizedQuery,
      replaceText: request.replaceText,
      include: request.include.trim(),
      exclude: request.exclude.trim(),
      beforeContextLines: clamp(request.beforeContextLines, 0, 20),
      afterContextLines: clamp(request.afterContextLines, 0, 20),
    };
    this.options = loadTextSearchOptions(normalizedRequest, this.groupingOverride);
    if (!normalizedQuery) {
      this.clear();
      return false;
    }
    const run = this.beginSearch(token);
    try {
      const result = await executeSearch(normalizedQuery, this.options, run.token);
      if (run.token.isCancellationRequested || run.runId !== this.activeSearchRunId) return false;
      this.query = normalizedQuery;
      this.request = normalizedRequest;
      this.matches = result.matches;
      this.lastWarning = result.warning;
      this.onDidChangeTreeDataEmitter.fire();
      return true;
    } catch (err) {
      if (run.token.isCancellationRequested || this.isSearchCancelled(err)) return false;
      throw err;
    } finally {
      run.dispose();
    }
  }

  async refresh(token?: vscode.CancellationToken): Promise<boolean> {
    if (!this.request?.query) return false;
    return await this.search(this.request, token);
  }

  dispose(): void {
    this.cancelActiveSearch();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}
