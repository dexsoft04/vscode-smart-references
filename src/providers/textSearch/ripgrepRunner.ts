import * as vscode from 'vscode';
import { spawn, execFile } from 'child_process';
import { rgPath as bundledRgPath } from '@vscode/ripgrep';
import { TextSearchOptions, RawSearchMatch, RgJsonMessage } from './types';
import { splitWorkspaceAndRelative } from './utils';
import { utf8ByteOffsetToUtf16Column, findMatchRange } from './fuzzySearch';

export function applyRgSearchFlags(args: string[], options: TextSearchOptions): void {
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

export function applySearchModeFlags(args: string[], query: string, options: TextSearchOptions): void {
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

let resolvedRgPath: string | undefined;
export let rgSourceLabel = 'pending';

const resolveRgPath = new Promise<string>(resolve => {
  execFile('rg', ['--version'], (err) => {
    resolvedRgPath = err ? bundledRgPath : 'rg';
    rgSourceLabel = resolvedRgPath === 'rg' ? 'system' : 'bundled';
    resolve(resolvedRgPath);
  });
});

function getRgPath(): string {
  return resolvedRgPath ?? bundledRgPath;
}

export async function runRgCommand(args: string[], token?: vscode.CancellationToken): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(getRgPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

export function parseRgOutput(rawOutput: string, query: string, options: TextSearchOptions): RawSearchMatch[] {
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

export async function executeFixedRgSearch(query: string, options: TextSearchOptions, token?: vscode.CancellationToken): Promise<RawSearchMatch[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) throw new Error('No workspace folder is open');

  const args = ['--json', '--line-number'];
  applySearchModeFlags(args, query, options);
  applyRgSearchFlags(args, options);
  args.push(query, ...folders.map(folder => folder.uri.fsPath));

  const stdout = await runRgCommand(args, token);
  return parseRgOutput(stdout, query, options);
}

// Ensure the promise is referenced to avoid tree-shaking
void resolveRgPath;
