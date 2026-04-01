import * as vscode from 'vscode';
import { ClassifiedReference, ReferenceCategory, CodeContext, locationKey } from '../core/ReferenceTypes';
import { ProtoReferenceBundle, ProtoWorkspaceNavigator } from '../core/ProtoWorkspaceNavigator';

function toLocations(raw: unknown): vscode.Location[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((x): x is vscode.Location => x instanceof vscode.Location);
}

export async function classifyDefinitionsAndImplementations(
  uri: vscode.Uri,
  position: vscode.Position,
  allRefs: vscode.Location[],
  protoNavigator?: ProtoWorkspaceNavigator,
  protoBundle?: ProtoReferenceBundle,
): Promise<ClassifiedReference[]> {
  const [defs, impls] = protoNavigator?.isProtoUri(uri)
    ? (protoBundle
      ? [protoBundle.definitions, protoBundle.implementations]
      : await Promise.all([
        protoNavigator.findDefinitions(uri, position),
        protoNavigator.findImplementations(uri, position),
      ]))
    : await Promise.all([
      vscode.commands.executeCommand<unknown>('vscode.executeDefinitionProvider', uri, position)
        .then(r => toLocations(r), () => []),
      vscode.commands.executeCommand<unknown>('vscode.executeImplementationProvider', uri, position)
        .then(r => toLocations(r), () => []),
    ]);

  const defKeys = new Set(defs.map(locationKey));
  const implKeys = new Set(impls.map(locationKey));

  const result: ClassifiedReference[] = [];

  for (const ref of allRefs) {
    const key = locationKey(ref);
    let category: ReferenceCategory;
    if (defKeys.has(key)) {
      category = ReferenceCategory.Definition;
    } else if (implKeys.has(key)) {
      category = ReferenceCategory.Implementation;
    } else {
      // Will be further classified by HighlightAnalyzer / SemanticTokenAnalyzer
      category = ReferenceCategory.ReadAccess;
    }
    result.push({
      location: ref,
      category,
      context: CodeContext.Production,
      lineText: '',
    });
  }

  return result;
}
