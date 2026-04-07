import * as vscode from 'vscode';
import { ClassifiedReference, ReferenceCategory, CodeContext, locationKey } from './ReferenceTypes';
import { classifyDefinitionsAndImplementations } from '../analyzers/DefinitionAnalyzer';
import { classifyReadWrite } from '../analyzers/HighlightAnalyzer';
import { markComments } from '../analyzers/SemanticTokenAnalyzer';
import { TestFileDetector } from '../analyzers/TestFileDetector';
import { ReferenceCache } from './Cache';
import { runConcurrent } from './concurrent';
import { MAX_CONCURRENT_LSP_REQUESTS } from './constants';
import { classifyUsageType } from '../analyzers/UsageClassifier';
import { ProtoReferenceBundle, ProtoWorkspaceNavigator } from './ProtoWorkspaceNavigator';

function findContainingSymbol(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position,
): string | undefined {
  for (const sym of symbols) {
    if (sym.range.contains(position)) {
      const child = findContainingSymbol(sym.children, position);
      if (child) return child;
      const fnKinds = [
        vscode.SymbolKind.Function,
        vscode.SymbolKind.Method,
        vscode.SymbolKind.Constructor,
      ];
      if (fnKinds.includes(sym.kind)) return sym.name;
    }
  }
  return undefined;
}

function markProtoReferences(refs: ClassifiedReference[]): void {
  for (const ref of refs) {
    if (
      ref.location.uri.fsPath.endsWith('.proto') &&
      ref.category !== ReferenceCategory.Definition &&
      ref.category !== ReferenceCategory.Implementation
    ) {
      ref.category = ReferenceCategory.Proto;
    }
  }
}

async function loadContainingSymbols(
  refs: ClassifiedReference[],
): Promise<Map<string, vscode.DocumentSymbol[]>> {
  const symbolsByFile = new Map<string, vscode.DocumentSymbol[]>();
  const byFile = new Map<string, ClassifiedReference[]>();
  for (const ref of refs) {
    const key = ref.location.uri.toString();
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(ref);
  }
  await runConcurrent(Array.from(byFile.values()), MAX_CONCURRENT_LSP_REQUESTS, async fileRefs => {
    try {
      const uri = fileRefs[0].location.uri;
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      if (!Array.isArray(symbols)) return;
      symbolsByFile.set(uri.toString(), symbols);
      for (const ref of fileRefs) {
        ref.containingSymbol = findContainingSymbol(symbols, ref.location.range.start);
      }
    } catch (err) {
      // leave containingSymbol undefined — file may be closed or LSP unavailable
      console.warn(`[ref-classifier] symbol load failed for ${fileRefs[0].location.uri.fsPath}: ${err}`);
    }
  });
  return symbolsByFile;
}

async function loadLineTexts(refs: ClassifiedReference[]): Promise<void> {
  const byFile = new Map<string, ClassifiedReference[]>();
  for (const ref of refs) {
    const key = ref.location.uri.toString();
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(ref);
  }

  await Promise.all(
    Array.from(byFile.entries()).map(async ([, fileRefs]) => {
      try {
        const doc = await vscode.workspace.openTextDocument(fileRefs[0].location.uri);
        const total = doc.lineCount;
        for (const ref of fileRefs) {
          const line = ref.location.range.start.line;
          ref.lineText = doc.lineAt(line).text;
          const before: string[] = [];
          for (let i = Math.max(0, line - 2); i < line; i++) {
            before.push(doc.lineAt(i).text);
          }
          const after: string[] = [];
          for (let i = line + 1; i <= Math.min(total - 1, line + 4); i++) {
            after.push(doc.lineAt(i).text);
          }
          ref.contextLines = { before, after };
        }
      } catch (err) {
        // File unreadable — leave lineText empty
        console.warn(`[ref-classifier] line text load failed for ${fileRefs[0].location.uri.fsPath}: ${err}`);
      }
    }),
  );
}

export class ReferenceClassifier {
  private testDetector: TestFileDetector;
  private cache: ReferenceCache;
  private protoNavigator: ProtoWorkspaceNavigator;

  constructor(testDetector: TestFileDetector, cache: ReferenceCache, protoNavigator: ProtoWorkspaceNavigator) {
    this.testDetector = testDetector;
    this.cache = cache;
    this.protoNavigator = protoNavigator;
  }

  async classify(
    uri: vscode.Uri,
    position: vscode.Position,
  ): Promise<{ symbolName: string; refs: ClassifiedReference[] }> {
    const cached = this.cache.get(uri, position);
    if (cached) return cached;

    // 1. Get all raw references
    let rawRefs: vscode.Location[] = [];
    let protoBundle: ProtoReferenceBundle | undefined;
    try {
      if (this.protoNavigator.isProtoUri(uri)) {
        protoBundle = await this.protoNavigator.resolveReferenceBundle(uri, position, true);
        rawRefs = protoBundle.references;
      } else {
        const result = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          uri,
          position,
        );
        if (Array.isArray(result)) rawRefs = result;
      }
    } catch {
      // No references found
    }

    if (rawRefs.length === 0) {
      let symbolName = '';
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const wordRange = doc.getWordRangeAtPosition(position);
        if (wordRange) symbolName = doc.getText(wordRange);
      } catch { /* ignore */ }
      return { symbolName, refs: [] };
    }

    // 2. Deduplicate by key
    const seen = new Set<string>();
    const uniqueRefs: vscode.Location[] = [];
    for (const ref of rawRefs) {
      const key = locationKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        uniqueRefs.push(ref);
      }
    }

    // 3. Classify definitions / implementations (establishes initial categories)
    const classified = await classifyDefinitionsAndImplementations(
      uri,
      position,
      uniqueRefs,
      this.protoNavigator,
      protoBundle,
    );

    // 4. Get call-site refs (non-definition, non-implementation)
    const callSites = classified.filter(r =>
      r.category !== ReferenceCategory.Definition &&
      r.category !== ReferenceCategory.Implementation
    );

    // 5. Mark test context (sync), then parallel: read/write + comment detection
    for (const ref of classified) {
      if (this.testDetector.isTestFile(ref.location.uri)) {
        ref.context = CodeContext.Test;
      }
    }
    await Promise.all([
      classifyReadWrite(callSites, uri, position),
    ]);
    markProtoReferences(classified);
    await markComments(classified);

    // 6. Load line preview text and containing function names (parallel)
    const [, symbolsByFile] = await Promise.all([
      loadLineTexts(classified),
      loadContainingSymbols(classified),
    ]);

    // 7. Refine usage categories (needs lineText + symbols from step 6)
    classifyUsageType(classified, symbolsByFile);

    // 8. Determine symbol name from the document word at position
    let symbolName = '';
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const wordRange = doc.getWordRangeAtPosition(position);
      if (wordRange) symbolName = doc.getText(wordRange);
    } catch {
      // ignore
    }

    const entry = { symbolName, refs: classified };
    this.cache.set(uri, position, entry);
    return entry;
  }
}
