import * as vscode from 'vscode';
import { DepSymbolIndexer } from './GoDepSymbolIndexer';

export abstract class BaseDepSymbolIndexer implements DepSymbolIndexer {
  private cache: vscode.SymbolInformation[] | undefined;
  private dirty = true;
  protected readonly log: vscode.OutputChannel;
  protected abstract readonly logPrefix: string;

  constructor(log: vscode.OutputChannel) {
    this.log = log;
  }

  invalidate(): void {
    this.dirty = true;
    this.cache = undefined;
  }

  async getSymbols(): Promise<vscode.SymbolInformation[]> {
    if (!this.dirty && this.cache) return this.cache;
    const t0 = Date.now();
    this.log.appendLine(`[${this.logPrefix}] building index...`);
    const result = await this.buildIndex();
    this.cache = result.symbols;
    this.dirty = false;
    const depSuffix = result.depCount !== undefined ? ` from ${result.depCount} deps` : '';
    this.log.appendLine(`[${this.logPrefix}] done: ${result.symbols.length} symbols${depSuffix} in ${Date.now() - t0}ms`);
    return this.cache;
  }

  protected abstract buildIndex(): Promise<{ symbols: vscode.SymbolInformation[]; depCount?: number }>;

  dispose(): void { /* nothing to clean up */ }
}
