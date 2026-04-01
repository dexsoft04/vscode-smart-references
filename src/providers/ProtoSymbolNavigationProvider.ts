import * as vscode from 'vscode';
import { ProtoWorkspaceNavigator } from '../core/ProtoWorkspaceNavigator';

export class ProtoSymbolNavigationProvider implements vscode.DefinitionProvider, vscode.ReferenceProvider, vscode.ImplementationProvider, vscode.Disposable {
  constructor(private readonly navigator: ProtoWorkspaceNavigator) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Thenable<vscode.Definition | vscode.DefinitionLink[]> {
    return this.navigator.findDefinitions(document.uri, position);
  }

  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
  ): Thenable<vscode.Location[]> {
    return this.navigator.findReferences(document.uri, position, context.includeDeclaration);
  }

  provideImplementation(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Thenable<vscode.Definition | vscode.DefinitionLink[]> {
    return this.navigator.findImplementations(document.uri, position);
  }

  dispose(): void {
    // stateless provider
  }
}
