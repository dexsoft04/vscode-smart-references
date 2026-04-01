import * as vscode from 'vscode';
import { ClassifiedReference, ReferenceCategory } from '../core/ReferenceTypes';
import { runConcurrent } from '../core/concurrent';

function rangesOverlap(a: vscode.Range, b: vscode.Range): boolean {
  return !a.end.isBefore(b.start) && !b.end.isBefore(a.start);
}

export async function classifyReadWrite(
  refs: ClassifiedReference[],
  originalUri: vscode.Uri,
  originalPosition: vscode.Position,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('smartReferences');
  if (!config.get<boolean>('enableReadWriteClassification', true)) return;

  // Group refs by file to minimize LSP calls
  const byFile = new Map<string, ClassifiedReference[]>();
  for (const ref of refs) {
    const key = ref.location.uri.toString();
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(ref);
  }

  await runConcurrent(Array.from(byFile.values()), 8, async (fileRefs) => {
      const refUri = fileRefs[0].location.uri;
      // Use any reference position in this file to query highlights
      const queryPos = refUri.toString() === originalUri.toString()
        ? originalPosition
        : fileRefs[0].location.range.start;

      let highlights: vscode.DocumentHighlight[] = [];
      try {
        const raw = await vscode.commands.executeCommand<vscode.DocumentHighlight[]>(
          'vscode.executeDocumentHighlights',
          refUri,
          queryPos,
        );
        if (Array.isArray(raw)) highlights = raw;
      } catch {
        // LSP doesn't support highlights — leave as ReadAccess
        return;
      }

      for (const ref of fileRefs) {
        const match = highlights.find(h => rangesOverlap(h.range, ref.location.range));
        if (!match) continue;
        if (match.kind === vscode.DocumentHighlightKind.Write) {
          ref.category = ReferenceCategory.WriteAccess;
        }
        // Read (1) or Text (0/undefined) → stays ReadAccess
      }
  });
}
