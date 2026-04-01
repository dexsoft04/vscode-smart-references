import * as vscode from 'vscode';
import { ClassifiedReference } from './ReferenceTypes';

interface CacheEntry {
  refs: ClassifiedReference[];
  symbolName: string;
}

const MAX_ENTRIES = 500;

export class ReferenceCache {
  private store = new Map<string, CacheEntry>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        this.invalidateFile(doc.uri);
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        this.invalidateFile(e.document.uri);
      }),
    );
  }

  private makeKey(uri: vscode.Uri, position: vscode.Position): string {
    return `${uri.toString()}:${position.line}:${position.character}`;
  }

  get(uri: vscode.Uri, position: vscode.Position): CacheEntry | undefined {
    return this.store.get(this.makeKey(uri, position));
  }

  set(uri: vscode.Uri, position: vscode.Position, entry: CacheEntry): void {
    if (this.store.size >= MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(this.makeKey(uri, position), entry);
  }

  private invalidateFile(uri: vscode.Uri): void {
    const prefix = uri.toString();
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.store.clear();
  }
}
