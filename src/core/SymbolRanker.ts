import * as vscode from 'vscode';
import * as path from 'path';
import {
  SCORE_EXACT_MATCH, SCORE_STARTS_WITH, SCORE_CAMEL_CASE, SCORE_CONTAINS,
  SCORE_LSP_BASE, SCORE_TEST_PENALTY, SCORE_LANG_BOOST, SCORE_PATH_WORKSPACE,
  SCORE_KIND_CLASS, SCORE_KIND_FUNCTION, SCORE_KIND_VARIABLE, SCORE_KIND_DEFAULT,
  SCORE_PROXIMITY_SAME_DIR, SCORE_PROXIMITY_SIBLING,
  SCORE_RECENT_MAX, SCORE_RECENT_DECAY, SCORE_LENGTH_PENALTY_CAP,
  MAX_RECENT_SYMBOLS, MAX_FILE_SEARCH_RESULTS,
} from './constants';

// ── Symbol categories ────────────────────────────────────────────────────────

export enum SymbolCategory {
  Class = 'Classes',
  Interface = 'Interfaces',
  Function = 'Functions & Methods',
  Variable = 'Variables & Constants',
  Enum = 'Enums',
  Other = 'Other',
  File = 'Files',
}

export const CATEGORY_ORDER: SymbolCategory[] = [
  SymbolCategory.Class,
  SymbolCategory.Interface,
  SymbolCategory.Function,
  SymbolCategory.Variable,
  SymbolCategory.Enum,
  SymbolCategory.Other,
  SymbolCategory.File,
];

export function symbolKindToCategory(kind: vscode.SymbolKind): SymbolCategory {
  switch (kind) {
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Constructor:
    case vscode.SymbolKind.Struct:       // Go / Rust / C++ struct
    case vscode.SymbolKind.TypeParameter: // generic type param
      return SymbolCategory.Class;
    case vscode.SymbolKind.Interface:
      return SymbolCategory.Interface;
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Operator:     // C++ / Rust operator overload
      return SymbolCategory.Function;
    case vscode.SymbolKind.Variable:
    case vscode.SymbolKind.Constant:
    case vscode.SymbolKind.Field:
    case vscode.SymbolKind.Property:
      return SymbolCategory.Variable;
    case vscode.SymbolKind.Enum:
    case vscode.SymbolKind.EnumMember:
      return SymbolCategory.Enum;
    default:
      return SymbolCategory.Other;
  }
}

const SYMBOL_KIND_ICONS: Partial<Record<vscode.SymbolKind, string>> = {
  [vscode.SymbolKind.Class]:         'symbol-class',
  [vscode.SymbolKind.Interface]:     'symbol-interface',
  [vscode.SymbolKind.Function]:      'symbol-function',
  [vscode.SymbolKind.Method]:        'symbol-method',
  [vscode.SymbolKind.Constructor]:   'symbol-method',
  [vscode.SymbolKind.Variable]:      'symbol-variable',
  [vscode.SymbolKind.Constant]:      'symbol-constant',
  [vscode.SymbolKind.Field]:         'symbol-field',
  [vscode.SymbolKind.Property]:      'symbol-property',
  [vscode.SymbolKind.Enum]:          'symbol-enum',
  [vscode.SymbolKind.EnumMember]:    'symbol-enum-member',
  [vscode.SymbolKind.Struct]:        'symbol-struct',
  [vscode.SymbolKind.TypeParameter]: 'symbol-type-parameter',
  [vscode.SymbolKind.Namespace]:     'symbol-namespace',
  [vscode.SymbolKind.Module]:        'symbol-module',
  [vscode.SymbolKind.Package]:       'symbol-package',
};

export function symbolKindToIconId(kind: vscode.SymbolKind): string {
  return SYMBOL_KIND_ICONS[kind] ?? 'symbol-misc';
}

// ── Ranking ──────────────────────────────────────────────────────────────────

export interface RankedSymbol {
  symbol: vscode.SymbolInformation;
  category: SymbolCategory;
  score: number;
}

export interface RankedFile {
  uri: vscode.Uri;
  score: number;
}

function symbolKey(sym: vscode.SymbolInformation): string {
  return sym.name + '\0' + sym.location.uri.toString();
}

export class SymbolRanker {
  private recent: vscode.SymbolInformation[] = [];
  private recentMap = new Map<string, number>();
  private excludeRe = /[/\\](node_modules|vendor|\.git|dist|out)[/\\]/;

  recordAccess(symbol: vscode.SymbolInformation): void {
    const key = symbolKey(symbol);
    this.recent = this.recent.filter(r => symbolKey(r) !== key);
    this.recent.unshift(symbol);
    if (this.recent.length > MAX_RECENT_SYMBOLS) this.recent.pop();
    this.rebuildRecentMap();
  }

  rank(
    query: string,
    symbols: vscode.SymbolInformation[],
    contextUri?: vscode.Uri,
    maxResults = 80,
    filterCategories: SymbolCategory[] = [],
    mainLangExtensions: string[] = [],
    isTest?: (uri: vscode.Uri) => boolean,
    queryAliases: string[] = [],
  ): RankedSymbol[] {
    const queries = [query, ...queryAliases]
      .map(item => item.trim().toLowerCase())
      .filter(Boolean);
    const contextDir = contextUri ? path.dirname(contextUri.fsPath) : undefined;
    const results: RankedSymbol[] = [];
    const seen = new Set<string>(); // deduplicate across multiple language providers

    for (const sym of symbols) {
      const key = symbolKey(sym);
      if (seen.has(key)) continue;
      seen.add(key);

      // Apply category filter early so out-of-category symbols don't consume the maxResults cap
      if (filterCategories.length > 0 && !filterCategories.includes(symbolKindToCategory(sym.kind))) continue;

      const name = sym.name;
      const nameLower = name.toLowerCase();

      let matchScore = 0;
      for (const q of queries) {
        if (nameLower === q) {
          matchScore = Math.max(matchScore, SCORE_EXACT_MATCH);
        } else if (nameLower.startsWith(q)) {
          matchScore = Math.max(matchScore, SCORE_STARTS_WITH);
        } else if (camelCaseMatch(q, name)) {
          matchScore = Math.max(matchScore, SCORE_CAMEL_CASE);
        } else if (nameLower.includes(q)) {
          matchScore = Math.max(matchScore, SCORE_CONTAINS);
        }
      }
      if (matchScore === 0) {
        matchScore = SCORE_LSP_BASE;
      }

      const kindScore = symbolKindScore(sym.kind);
      const pathScore = this.pathScore(sym.location.uri);
      const recentScore = this.recentScore(sym);
      const proximity = this.proximityScore(sym.location.uri, contextDir);
      const langBoost = mainLangScore(sym.location.uri, mainLangExtensions);
      const testPenalty = isTest?.(sym.location.uri) ? SCORE_TEST_PENALTY : 0;
      const lengthPenalty = Math.min(name.length, SCORE_LENGTH_PENALTY_CAP);

      results.push({
        symbol: sym,
        category: symbolKindToCategory(sym.kind),
        score: matchScore + kindScore + pathScore + recentScore + proximity + langBoost + testPenalty - lengthPenalty,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return maxResults > 0 ? results.slice(0, maxResults) : results;
  }

  rankFiles(
    query: string,
    fileUris: vscode.Uri[],
    contextUri?: vscode.Uri,
    maxResults = MAX_FILE_SEARCH_RESULTS,
    mainLangExtensions: string[] = [],
    isTest?: (uri: vscode.Uri) => boolean,
  ): RankedFile[] {
    const queryLower = query.toLowerCase();
    const contextDir = contextUri ? path.dirname(contextUri.fsPath) : undefined;
    const results: RankedFile[] = [];

    for (const uri of fileUris) {
      const basename = path.basename(uri.fsPath);
      const baseNoExt = basename.replace(/\.[^.]+$/, '');
      const basenameLower = basename.toLowerCase();
      const baseNoExtLower = baseNoExt.toLowerCase();

      let matchScore = 0;
      if (baseNoExtLower === queryLower) {
        matchScore = SCORE_EXACT_MATCH;
      } else if (baseNoExtLower.startsWith(queryLower)) {
        matchScore = SCORE_STARTS_WITH;
      } else if (camelCaseMatch(queryLower, baseNoExt)) {
        matchScore = SCORE_CAMEL_CASE;
      } else if (basenameLower.includes(queryLower)) {
        matchScore = SCORE_CONTAINS;
      } else {
        continue;
      }

      const pathScore = this.pathScore(uri);
      const proximity = this.proximityScore(uri, contextDir);
      const langBoost = mainLangScore(uri, mainLangExtensions);
      const testPenalty = isTest?.(uri) ? SCORE_TEST_PENALTY : 0;
      const lengthPenalty = Math.min(basename.length, SCORE_LENGTH_PENALTY_CAP);

      results.push({
        uri,
        score: matchScore + pathScore + proximity + langBoost + testPenalty - lengthPenalty,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return maxResults > 0 ? results.slice(0, maxResults) : results;
  }

  getRecentSymbols(): vscode.SymbolInformation[] {
    return [...this.recent];
  }

  private rebuildRecentMap(): void {
    this.recentMap.clear();
    for (let i = 0; i < this.recent.length; i++) {
      this.recentMap.set(symbolKey(this.recent[i]), i);
    }
  }

  private pathScore(uri: vscode.Uri): number {
    return this.excludeRe.test(uri.fsPath) ? 0 : SCORE_PATH_WORKSPACE;
  }

  private recentScore(sym: vscode.SymbolInformation): number {
    const idx = this.recentMap.get(symbolKey(sym));
    if (idx === undefined) return 0;
    return Math.max(0, SCORE_RECENT_MAX - idx * SCORE_RECENT_DECAY);
  }

  private proximityScore(symbolUri: vscode.Uri, contextDir: string | undefined): number {
    if (!contextDir) return 0;
    const symbolDir = path.dirname(symbolUri.fsPath);
    if (symbolDir === contextDir) return SCORE_PROXIMITY_SAME_DIR;
    if (path.dirname(symbolDir) === path.dirname(contextDir)) return SCORE_PROXIMITY_SIBLING;
    return 0;
  }
}

function symbolKindScore(kind: vscode.SymbolKind): number {
  switch (kind) {
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Enum:
      return SCORE_KIND_CLASS;
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return SCORE_KIND_FUNCTION;
    case vscode.SymbolKind.Variable:
    case vscode.SymbolKind.Constant:
      return SCORE_KIND_VARIABLE;
    default:
      return SCORE_KIND_DEFAULT;
  }
}

function camelCaseMatch(query: string, name: string): boolean {
  const wordStarts: number[] = [0];
  for (let i = 1; i < name.length; i++) {
    const ch = name[i];
    if (ch >= 'A' && ch <= 'Z') wordStarts.push(i);
    else if (name[i - 1] === '_' || name[i - 1] === '-') wordStarts.push(i);
  }

  let qi = 0;
  for (const pos of wordStarts) {
    if (qi >= query.length) break;
    if (name[pos].toLowerCase() === query[qi].toLowerCase()) qi++;
  }
  return qi === query.length;
}

function mainLangScore(uri: vscode.Uri, extensions: string[]): number {
  if (extensions.length === 0) return 0;
  const p = uri.fsPath;
  return extensions.some(ext => p.endsWith(ext)) ? SCORE_LANG_BOOST : 0;
}
