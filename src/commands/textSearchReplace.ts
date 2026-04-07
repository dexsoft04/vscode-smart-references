import * as vscode from 'vscode';
import { TextSearchRequest, TextSearchReplaceTarget } from '../providers/TextSearchTreeProvider';
import { t } from '../i18n';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReplacementFileContext {
  readonly uri: vscode.Uri;
  readonly originalText: string;
  readonly originalLineOffsets: number[];
  currentLineOffsets: number[];
  workingText: string;
  applied: Array<{ originalStart: number; delta: number }>;
}

export interface ReplacementSessionOperation {
  readonly uri: string;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly appliedLineNumber: number;
  readonly matchedText: string;
  readonly replacementText: string;
}

export interface ReplacementSessionFileSnapshot {
  readonly uri: string;
  readonly relativePath: string;
  readonly beforeText: string;
  readonly afterText: string;
}

export interface ReplacementSessionRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly mode: 'single' | 'all';
  readonly query: string;
  readonly replaceText: string;
  readonly regex: boolean;
  readonly matchCase: boolean;
  readonly matchWholeWord: boolean;
  readonly appliedCount: number;
  readonly files: ReplacementSessionFileSnapshot[];
  readonly operations: ReplacementSessionOperation[];
  readonly stoppedReason?: string;
  undoneAt?: string;
}

// ── Pure utility functions ───────────────────────────────────────────────────

export function buildLineOffsets(value: string): number[] {
  const offsets = [0];
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

export function offsetAt(lineOffsets: number[], line: number, character: number): number {
  return (lineOffsets[line] ?? lineOffsets[lineOffsets.length - 1] ?? 0) + character;
}

export function getAdjustedOffset(originalOffset: number, applied: Array<{ originalStart: number; delta: number }>): number {
  let delta = 0;
  for (const change of applied) {
    if (change.originalStart < originalOffset) delta += change.delta;
  }
  return originalOffset + delta;
}

export function positionAtOffset(lineOffsets: number[], content: string, offset: number): vscode.Position {
  const clampedOffset = Math.max(0, Math.min(offset, content.length));
  let low = 0;
  let high = lineOffsets.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (lineOffsets[mid] <= clampedOffset) low = mid;
    else high = mid - 1;
  }
  return new vscode.Position(low, clampedOffset - (lineOffsets[low] ?? 0));
}

export function createReplaceRegExp(request: TextSearchRequest): RegExp | undefined {
  if (!request.useRegExp) return undefined;
  const flags = request.matchCase ? 'u' : 'iu';
  return new RegExp(request.query, flags);
}

export function applyReplacementText(matchedText: string, request: TextSearchRequest): string {
  if (!request.useRegExp) return request.replaceText;
  const regex = createReplaceRegExp(request);
  if (!regex) return request.replaceText;
  return matchedText.replace(regex, request.replaceText);
}

export function formatLogValue(value: string): string {
  return value.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function createReplaceSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getReplacementFileContext(
  cache: Map<string, ReplacementFileContext>,
  uriText: string,
): Promise<ReplacementFileContext> {
  const cached = cache.get(uriText);
  if (cached) return cached;
  const uri = vscode.Uri.parse(uriText);
  const document = await vscode.workspace.openTextDocument(uri);
  const originalText = document.getText();
  const initialLineOffsets = buildLineOffsets(originalText);
  const ctx: ReplacementFileContext = {
    uri,
    originalText,
    originalLineOffsets: initialLineOffsets,
    currentLineOffsets: initialLineOffsets,
    workingText: originalText,
    applied: [],
  };
  cache.set(uriText, ctx);
  return ctx;
}

export function buildUndoReplaceDetail(session: ReplacementSessionRecord): string {
  const linesByFile = new Map<string, number[]>();
  for (const operation of session.operations) {
    const lines = linesByFile.get(operation.relativePath) ?? [];
    lines.push(operation.appliedLineNumber ?? operation.lineNumber);
    linesByFile.set(operation.relativePath, lines);
  }
  const entries = [...linesByFile.entries()]
    .map(([relativePath, lines]) => {
      const uniqueLines = [...new Set(lines)].sort((a, b) => a - b);
      const preview = uniqueLines.slice(0, 8).join(', ');
      const suffix = uniqueLines.length > 8
        ? t(` 等 ${uniqueLines.length} 行`, ` and ${uniqueLines.length - 8} more`)
        : '';
      return `${relativePath}: ${preview}${suffix}`;
    })
    .slice(0, 8);
  const extraFiles = linesByFile.size - entries.length;
  return [
    t('只有当这些文件仍保持该批替换后的内容时，才会执行安全回滚。', 'Safe rollback runs only when these files still match the post-replacement content from this batch.'),
    ...entries,
    ...(extraFiles > 0 ? [t(`其余 ${extraFiles} 个文件未展开。`, `${extraFiles} more files are not expanded.`)] : []),
  ].join('\n');
}

// ── Replace execution engine ─────────────────────────────────────────────────

export interface ReplaceExecutionDeps {
  outputChannel: vscode.OutputChannel;
  appendHistory: (session: ReplacementSessionRecord) => Promise<void>;
}

export async function executeReplace(
  deps: ReplaceExecutionDeps,
  request: TextSearchRequest,
  targets: TextSearchReplaceTarget[],
  mode: 'single' | 'all',
): Promise<{ session: ReplacementSessionRecord | undefined; error?: string }> {
  const { outputChannel, appendHistory } = deps;
  const fileContexts = new Map<string, ReplacementFileContext>();
  const startedAt = new Date().toISOString();
  const sessionId = createReplaceSessionId();
  const sessionOperations: ReplacementSessionOperation[] = [];
  let completed = 0;

  outputChannel.appendLine(`[text-search:replace] start id=${sessionId} ${startedAt} mode=${mode} files=${new Set(targets.map(t => t.uri)).size} matches=${targets.length}`);
  outputChannel.appendLine(`[text-search:replace] id=${sessionId} query=${JSON.stringify(request.query)} regex=${request.useRegExp} case=${request.matchCase} word=${request.matchWholeWord}`);

  const persistSession = async (stoppedReason?: string): Promise<ReplacementSessionRecord | undefined> => {
    if (completed === 0) return undefined;
    const files = [...fileContexts.values()]
      .filter(ctx => ctx.applied.length > 0)
      .map(ctx => ({
        uri: ctx.uri.toString(),
        relativePath: vscode.workspace.asRelativePath(ctx.uri, false),
        beforeText: ctx.originalText,
        afterText: ctx.workingText,
      }));
    const session: ReplacementSessionRecord = {
      id: sessionId,
      startedAt,
      completedAt: new Date().toISOString(),
      mode,
      query: request.query,
      replaceText: request.replaceText,
      regex: request.useRegExp,
      matchCase: request.matchCase,
      matchWholeWord: request.matchWholeWord,
      appliedCount: completed,
      files,
      operations: sessionOperations,
      stoppedReason,
    };
    await appendHistory(session);
    outputChannel.appendLine(`[text-search:replace] stored id=${sessionId} applied=${completed} files=${files.length}${stoppedReason ? ` stopped=${JSON.stringify(stoppedReason)}` : ''}`);
    return session;
  };

  try {
    for (const target of targets) {
      const ctx = await getReplacementFileContext(fileContexts, target.uri);
      const originalStart = offsetAt(ctx.originalLineOffsets, target.startLine, target.startCharacter);
      const originalEnd = offsetAt(ctx.originalLineOffsets, target.endLine, target.endCharacter);
      const adjustedStart = getAdjustedOffset(originalStart, ctx.applied);
      const adjustedEnd = getAdjustedOffset(originalEnd, ctx.applied);
      const currentSlice = ctx.workingText.slice(adjustedStart, adjustedEnd);

      if (currentSlice !== target.matchedText) {
        const message = `stale match; expected=${JSON.stringify(target.matchedText)} actual=${JSON.stringify(currentSlice)}`;
        outputChannel.appendLine(`[text-search:replace] fail id=${sessionId} ${target.relativePath}:${target.lineNumber} ${message}`);
        throw new Error(`${t('替换已在', 'Replacement stopped at')} ${target.relativePath}:${target.lineNumber}: ${message}`);
      }

      const replacementText = applyReplacementText(currentSlice, request);
      const range = new vscode.Range(
        positionAtOffset(ctx.currentLineOffsets, ctx.workingText, adjustedStart),
        positionAtOffset(ctx.currentLineOffsets, ctx.workingText, adjustedEnd),
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(ctx.uri, range, replacementText);
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        const message = 'workspace.applyEdit returned false';
        outputChannel.appendLine(`[text-search:replace] fail id=${sessionId} ${target.relativePath}:${target.lineNumber} ${message}`);
        throw new Error(`${t('替换已在', 'Replacement stopped at')} ${target.relativePath}:${target.lineNumber}: ${message}`);
      }

      ctx.workingText = `${ctx.workingText.slice(0, adjustedStart)}${replacementText}${ctx.workingText.slice(adjustedEnd)}`;
      ctx.currentLineOffsets = buildLineOffsets(ctx.workingText);
      ctx.applied.push({ originalStart, delta: replacementText.length - currentSlice.length });
      sessionOperations.push({
        uri: target.uri,
        relativePath: target.relativePath,
        lineNumber: target.lineNumber,
        appliedLineNumber: range.start.line + 1,
        matchedText: currentSlice,
        replacementText,
      });
      completed += 1;
      outputChannel.appendLine(
        `[text-search:replace] ok id=${sessionId} ${target.relativePath}:${target.lineNumber} match=${JSON.stringify(formatLogValue(currentSlice))} replace=${JSON.stringify(formatLogValue(replacementText))}`,
      );
    }

    outputChannel.appendLine(`[text-search:replace] done id=${sessionId} mode=${mode} completed=${completed}/${targets.length}`);
    const session = await persistSession();
    return { session };
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    outputChannel.appendLine(`[text-search:replace] stopped id=${sessionId} completed=${completed}/${targets.length} reason=${message}`);
    await persistSession(message);
    return { session: undefined, error: message };
  }
}

export async function executeUndo(
  outputChannel: vscode.OutputChannel,
  session: ReplacementSessionRecord,
): Promise<{ error?: string }> {
  outputChannel.appendLine(`[text-search:undo] start id=${session.id} files=${session.files.length} applied=${session.appliedCount}`);
  outputChannel.appendLine(`[text-search:undo] id=${session.id} query=${JSON.stringify(session.query)} regex=${session.regex} case=${session.matchCase} word=${session.matchWholeWord}`);

  try {
    const edit = new vscode.WorkspaceEdit();
    for (const file of session.files) {
      const uri = vscode.Uri.parse(file.uri);
      const document = await vscode.workspace.openTextDocument(uri);
      const currentText = document.getText();
      if (currentText !== file.afterText) {
        const message = t(`文件已变化，无法安全撤销: ${file.relativePath}`, `File changed; cannot safely undo: ${file.relativePath}`);
        outputChannel.appendLine(`[text-search:undo] fail id=${session.id} ${message}`);
        throw new Error(message);
      }
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(currentText.length));
      edit.replace(uri, fullRange, file.beforeText);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      const message = 'workspace.applyEdit returned false';
      outputChannel.appendLine(`[text-search:undo] fail id=${session.id} ${message}`);
      throw new Error(`${t('撤销替换', 'Undo replace')} ${session.id} ${t('失败', 'failed')}: ${message}`);
    }

    for (const operation of [...session.operations].reverse()) {
      outputChannel.appendLine(
        `[text-search:undo] ok id=${session.id} ${operation.relativePath}:${operation.appliedLineNumber ?? operation.lineNumber} match=${JSON.stringify(formatLogValue(operation.replacementText))} replace=${JSON.stringify(formatLogValue(operation.matchedText))}`,
      );
    }

    outputChannel.appendLine(`[text-search:undo] done id=${session.id} files=${session.files.length} reverted=${session.operations.length}`);
    return {};
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    outputChannel.appendLine(`[text-search:undo] stopped id=${session.id} reason=${message}`);
    return { error: message };
  }
}
