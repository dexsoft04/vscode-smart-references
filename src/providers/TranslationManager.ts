import * as vscode from 'vscode';
import { createTranslationProvider, TranslationProvider } from '../core/TranslationService';
import { decodeTokens } from '../analyzers/SemanticTokenAnalyzer';
import { runConcurrent } from '../core/concurrent';

// Non-code language IDs — translate the full text directly
const PLAIN_TEXT_LANGS = new Set([
  'markdown', 'plaintext', 'text', 'json', 'jsonc',
  'yaml', 'toml', 'xml', 'html', 'css', 'ini', 'properties',
]);

// Project/dependency config filenames and extensions to block when
// smartReferences.translation.skipProjectFiles is enabled.
const PROJECT_FILE_NAMES = new Set([
  'go.mod', 'go.sum', 'go.work', 'go.work.sum',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'cargo.toml', 'cargo.lock',
  'pyproject.toml', 'requirements.txt', 'pipfile', 'pipfile.lock', 'poetry.lock', 'setup.py', 'setup.cfg',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'gemfile', 'gemfile.lock',
  'composer.json', 'composer.lock',
  'pubspec.yaml', 'pubspec.lock',
  'makefile', 'cmakelists.txt',
]);
const PROJECT_FILE_EXTS = new Set([
  '.sln', '.csproj', '.vbproj', '.fsproj',
  '.lock', '.sum',
]);

function isProjectFile(fsPath: string): boolean {
  const base = fsPath.split(/[\\/]/).pop() ?? '';
  if (PROJECT_FILE_NAMES.has(base.toLowerCase())) return true;
  const dot = base.lastIndexOf('.');
  if (dot !== -1 && PROJECT_FILE_EXTS.has(base.slice(dot).toLowerCase())) return true;
  return false;
}

// ── Comment range extraction ──────────────────────────────────────────────────

interface CommentRange { range: vscode.Range; text: string; }

async function extractCommentRanges(doc: vscode.TextDocument): Promise<CommentRange[]> {
  // 1. Try semantic tokens first (LSP-backed, language-agnostic)
  try {
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
      'vscode.provideDocumentSemanticTokensLegend', doc.uri,
    );
    if (legend) {
      const commentIndex = legend.tokenTypes.indexOf('comment');
      if (commentIndex !== -1) {
        const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
          'vscode.provideDocumentSemanticTokens', doc.uri,
        );
        if (tokens?.data) {
          return decodeTokens(tokens.data)
            .filter(t => t.tokenTypeIndex === commentIndex)
            .map(t => {
              const range = new vscode.Range(t.line, t.startChar, t.line, t.startChar + t.length);
              return { range, text: doc.getText(range) };
            });
        }
      }
    }
  } catch { /* language server not ready, fall through to regex */ }

  // 2. Regex fallback
  return extractCommentRangesRegex(doc);
}

function extractCommentRangesRegex(doc: vscode.TextDocument): CommentRange[] {
  const text = doc.getText();
  const results: CommentRange[] = [];

  // Block comments /* ... */
  const blockRe = /\/\*[\s\S]*?\*\//g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const start = doc.positionAt(m.index);
    const end = doc.positionAt(m.index + m[0].length);
    results.push({ range: new vscode.Range(start, end), text: m[0] });
  }

  // Line comments // ... (not inside block comments already found)
  const lineRe = /\/\/[^\n]*/g;
  const blockOffsets = new Set<number>();
  for (const r of results) {
    const s = doc.offsetAt(r.range.start), e = doc.offsetAt(r.range.end);
    for (let i = s; i <= e; i++) blockOffsets.add(i);
  }
  while ((m = lineRe.exec(text)) !== null) {
    if (!blockOffsets.has(m.index)) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      results.push({ range: new vscode.Range(start, end), text: m[0] });
    }
  }

  // Python / Shell hash comments # ...
  const hashRe = /#[^\n]*/g;
  while ((m = hashRe.exec(text)) !== null) {
    if (!blockOffsets.has(m.index)) {
      const start = doc.positionAt(m.index);
      const end = doc.positionAt(m.index + m[0].length);
      results.push({ range: new vscode.Range(start, end), text: m[0] });
    }
  }

  // Python triple-quoted docstrings """ ... """
  const tripleRe = /"""[\s\S]*?"""|'''[\s\S]*?'''/g;
  while ((m = tripleRe.exec(text)) !== null) {
    const start = doc.positionAt(m.index);
    const end = doc.positionAt(m.index + m[0].length);
    results.push({ range: new vscode.Range(start, end), text: m[0] });
  }

  // Sort by document order
  results.sort((a, b) => a.range.start.compareTo(b.range.start));
  return results;
}

// ── Strip comment syntax to get raw text ─────────────────────────────────────

function stripCommentSyntax(commentText: string): string {
  // Block comment /* ... */
  if (commentText.startsWith('/*')) {
    return commentText.slice(2, -2).replace(/^\s*\*\s?/gm, '').trim();
  }
  // Python docstrings
  if (commentText.startsWith('"""') || commentText.startsWith("'''")) {
    return commentText.slice(3, -3).trim();
  }
  // Line comments // or #
  return commentText.replace(/^[/#]+\s?/gm, '').trim();
}

// Returns true if the text already contains enough CJK characters to be
// considered written in Chinese — no need to translate.
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
function hasChinese(text: string): boolean {
  const matches = text.match(CJK_RE);
  return matches !== null && matches.length >= 2;
}

// ── Build bilingual code output ───────────────────────────────────────────────

function buildBilingualCode(
  doc: vscode.TextDocument,
  comments: CommentRange[],
  translations: string[],
): string {
  const lines = doc.getText().split('\n');
  // Collect insertions keyed by line number (after which line to insert)
  const insertAfter = new Map<number, string[]>();

  for (let i = 0; i < comments.length; i++) {
    const { range, text } = comments[i];
    const translated = translations[i];
    if (!translated) continue;

    const endLine = range.end.line;
    if (!insertAfter.has(endLine)) insertAfter.set(endLine, []);

    // Detect indent from start of comment
    const indent = lines[range.start.line].match(/^(\s*)/)?.[1] ?? '';

    if (text.startsWith('/*')) {
      insertAfter.get(endLine)!.push(`${indent}/* [译] ${translated.replace(/\n/g, ' ')} */`);
    } else if (text.startsWith('"""') || text.startsWith("'''")) {
      const q = text.startsWith('"""') ? '"""' : "'''";
      insertAfter.get(endLine)!.push(`${indent}${q} [译] ${translated.replace(/\n/g, ' ')} ${q}`);
    } else {
      // Line comment — strip prefix, use same prefix
      const prefix = text.match(/^([/#]+\s?)/)?.[1] ?? '// ';
      insertAfter.get(endLine)!.push(`${indent}${prefix}[译] ${translated}`);
    }
  }

  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    output.push(lines[i]);
    const extras = insertAfter.get(i);
    if (extras) output.push(...extras);
  }
  return output.join('\n');
}

// ── TranslationManager ────────────────────────────────────────────────────────

interface PendingHover {
  docUri: string;
  range: vscode.Range;
  content: vscode.MarkdownString;
}

export class TranslationManager implements
  vscode.TextDocumentContentProvider,
  vscode.HoverProvider,
  vscode.Disposable {

  private readonly cache = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private pendingHover: PendingHover | undefined;
  private clearHoverTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly log: vscode.OutputChannel) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.cache.get(uri.toString()) ?? '';
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const p = this.pendingHover;
    if (!p || p.docUri !== document.uri.toString()) return undefined;
    if (!p.range.contains(position)) return undefined;
    return new vscode.Hover(p.content, p.range);
  }

  async executeTranslate(editor: vscode.TextEditor): Promise<void> {
    const config = vscode.workspace.getConfiguration('smartReferences.translation');

    const hasSelection = !editor.selection.isEmpty;
    if (!hasSelection && config.get<boolean>('skipProjectFiles', false)) {
      if (isProjectFile(editor.document.uri.fsPath)) {
        vscode.window.showInformationMessage('Translation skipped: project/dependency config file.');
        return;
      }
    }

    let provider: TranslationProvider;
    try {
      provider = createTranslationProvider(config);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Translation: ${(err as Error).message}`);
      return;
    }
    if (hasSelection) {
      await this.translateSelection(editor, provider);
    } else {
      await this.translateWholeFile(editor, provider);
    }
  }

  private async translateWholeFile(
    editor: vscode.TextEditor,
    provider: TranslationProvider,
  ): Promise<void> {
    const doc = editor.document;
    const isCode = !PLAIN_TEXT_LANGS.has(doc.languageId);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Translating…', cancellable: false },
      async () => {
        let content: string;
        try {
          if (isCode) {
            const comments = await extractCommentRanges(doc);
            if (comments.length === 0) {
              vscode.window.showInformationMessage('No comments found in this file.');
              return;
            }
            const rawTexts = comments.map(c => stripCommentSyntax(c.text));
            const translations = new Array<string>(rawTexts.length).fill('');
            let skipped = 0;
            await runConcurrent(
              rawTexts.map((text, idx) => ({ text, idx })),
              5,
              async ({ text, idx }) => {
                if (hasChinese(text)) { skipped++; return; }
                translations[idx] = await provider.translate(text);
              },
            );
            content = buildBilingualCode(doc, comments, translations);
            this.log.appendLine(`[translation] code file: ${comments.length - skipped} translated, ${skipped} skipped (already Chinese)`);
          } else {
            content = await provider.translate(doc.getText());
            this.log.appendLine(`[translation] plain file translated`);
          }
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`Translation failed: ${(err as Error).message}`);
          return;
        }

        const uri = vscode.Uri.parse(
          `translation-view://${encodeURIComponent(doc.uri.fsPath)}?lang=${doc.languageId}`,
        );
        this.cache.set(uri.toString(), content);
        this._onDidChange.fire(uri);
        await vscode.window.showTextDocument(uri, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
          preserveFocus: true,
        });
      },
    );
  }

  private async translateSelection(
    editor: vscode.TextEditor,
    provider: TranslationProvider,
  ): Promise<void> {
    const text = editor.document.getText(editor.selection);
    if (!text.trim()) return;

    let translated = '';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Translating…', cancellable: false },
      async () => {
        try {
          translated = await provider.translate(text);
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`Translation failed: ${(err as Error).message}`);
        }
      },
    );

    if (!translated) return;

    const md = new vscode.MarkdownString();
    md.appendMarkdown('**译文**\n\n');
    md.appendText(translated);
    md.isTrusted = false;

    clearTimeout(this.clearHoverTimer);
    this.pendingHover = {
      docUri: editor.document.uri.toString(),
      range: editor.selection,
      content: md,
    };
    // Auto-clear after 60 s so the hover provider doesn't linger forever
    this.clearHoverTimer = setTimeout(() => { this.pendingHover = undefined; }, 60_000);

    await vscode.commands.executeCommand('editor.action.showHover');
    this.log.appendLine(`[translation] selection translated (${text.length} chars)`);
  }

  dispose(): void {
    this._onDidChange.dispose();
    clearTimeout(this.clearHoverTimer);
  }
}
