import * as vscode from 'vscode';

export enum ReferenceCategory {
  Definition = 'Definition',
  Implementation = 'Implementation',
  Proto = 'Proto',
  Import = 'Import',
  FieldDeclaration = 'FieldDeclaration',
  ParameterDeclaration = 'ParameterDeclaration',
  ReturnType = 'ReturnType',
  Instantiation = 'Instantiation',
  ReadAccess = 'ReadAccess',
  WriteAccess = 'WriteAccess',
  Comment = 'Comment',
}

export enum CodeContext {
  Production = 'Production',
  Test = 'Test',
}

export interface ClassifiedReference {
  location: vscode.Location;
  category: ReferenceCategory;
  context: CodeContext;
  lineText: string;
  containingSymbol?: string;
  contextLines?: { before: string[]; after: string[] };
}

export function locationKey(loc: vscode.Location): string {
  return `${loc.uri.toString()}:${loc.range.start.line}:${loc.range.start.character}`;
}
