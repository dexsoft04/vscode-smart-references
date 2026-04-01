import * as vscode from 'vscode';
import { ClassifiedReference, ReferenceCategory } from '../core/ReferenceTypes';
import { runConcurrent } from '../core/concurrent';

export interface DecodedToken {
  line: number;
  startChar: number;
  length: number;
  tokenTypeIndex: number;
}

export function decodeTokens(data: Uint32Array): DecodedToken[] {
  const result: DecodedToken[] = [];
  let line = 0;
  let startChar = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaStart = data[i + 1];
    const length = data[i + 2];
    const tokenTypeIndex = data[i + 3];
    if (deltaLine > 0) {
      line += deltaLine;
      startChar = deltaStart;
    } else {
      startChar += deltaStart;
    }
    result.push({ line, startChar, length, tokenTypeIndex });
  }
  return result;
}

export async function markComments(
  refs: ClassifiedReference[],
): Promise<void> {
  const config = vscode.workspace.getConfiguration('smartReferences');
  if (!config.get<boolean>('enableCommentDetection', true)) return;

  // Only operate on non-definition, non-implementation refs
  const candidates = refs.filter(r =>
    r.category !== ReferenceCategory.Definition &&
    r.category !== ReferenceCategory.Implementation
  );
  if (candidates.length === 0) return;

  const byFile = new Map<string, ClassifiedReference[]>();
  for (const ref of candidates) {
    const key = ref.location.uri.toString();
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(ref);
  }

  await runConcurrent(Array.from(byFile.values()), 8, async fileRefs => {
      const uri = fileRefs[0].location.uri;
      try {
        const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
          'vscode.provideDocumentSemanticTokensLegend',
          uri,
        );
        if (!legend) return;

        const commentIndex = legend.tokenTypes.indexOf('comment');
        if (commentIndex === -1) return;

        const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
          'vscode.provideDocumentSemanticTokens',
          uri,
        );
        if (!tokens?.data) return;

        const decoded = decodeTokens(tokens.data);
        const commentRanges = decoded
          .filter(t => t.tokenTypeIndex === commentIndex)
          .map(t => new vscode.Range(t.line, t.startChar, t.line, t.startChar + t.length));

        for (const ref of fileRefs) {
          const refStart = ref.location.range.start;
          const inComment = commentRanges.some(cr =>
            cr.start.line === refStart.line &&
            cr.start.character <= refStart.character &&
            cr.end.character >= refStart.character
          );
          if (inComment) {
            ref.category = ReferenceCategory.Comment;
          }
        }
      } catch {
        // Language server doesn't support semantic tokens — skip
      }
  });
}
