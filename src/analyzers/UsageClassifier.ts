import * as vscode from 'vscode';
import { ClassifiedReference, ReferenceCategory } from '../core/ReferenceTypes';

// TS/JS: import/require/export...from  |  C/C++: #include  |  Python: import/from...import
const IMPORT_RE = /\b(import|require)\b|export\s.*\bfrom\b|^\s*#\s*include\b/;

function isImport(lineText: string): boolean {
  return IMPORT_RE.test(lineText);
}

function isInstantiation(lineText: string, refStart: number): boolean {
  const before = lineText.slice(0, refStart);
  return /\bnew\s+$/.test(before);
}

function isParameterType(lineText: string, refStart: number): boolean {
  const before = lineText.slice(0, refStart);
  // Require an unmatched `(` earlier on the line — ensures we're inside a function signature,
  // not an object literal like `{ key: Type }`.
  const openParens = (before.match(/\(/g) || []).length;
  const closeParens = (before.match(/\)/g) || []).length;
  if (openParens <= closeParens) return false;
  // TS: `(paramName: Type` or `, paramName: Type`
  return /\w\s*:\s*[\w<>\[\]|&,\s]*$/.test(before);
}

function isReturnType(lineText: string, refStart: number, refEnd: number): boolean {
  const before = lineText.slice(0, refStart);
  // TS/Kotlin style: `): Type`
  if (/\)\s*:\s*[\w<>\[\]|&,\s]*$/.test(before)) return true;
  // C++/Java/Go style: `Type funcName(` — return type at line start
  const after = lineText.slice(refEnd);
  if (/^\s+\w+\s*\(/.test(after) && /^\s*$/.test(lineText.slice(0, refStart))) return true;
  return false;
}

interface FlattenedSymbol {
  symbol: vscode.DocumentSymbol;
  parents: vscode.DocumentSymbol[];
}

function flattenSymbols(
  symbols: vscode.DocumentSymbol[],
  parents: vscode.DocumentSymbol[] = [],
): FlattenedSymbol[] {
  const result: FlattenedSymbol[] = [];
  for (const sym of symbols) {
    result.push({ symbol: sym, parents });
    if (sym.children.length > 0) {
      result.push(...flattenSymbols(sym.children, [...parents, sym]));
    }
  }
  return result;
}

function isTypeLikeContainer(kind: vscode.SymbolKind): boolean {
  return kind === vscode.SymbolKind.Class
    || kind === vscode.SymbolKind.Interface
    || kind === vscode.SymbolKind.Struct;
}

function isInFieldTypeAnnotation(
  ref: ClassifiedReference,
  allSymbols: FlattenedSymbol[],
): boolean {
  const pos = ref.location.range.start;
  const line = ref.lineText;
  for (const { symbol: sym, parents } of allSymbols) {
    if (
      (sym.kind === vscode.SymbolKind.Field || sym.kind === vscode.SymbolKind.Property) &&
      sym.range.contains(pos)
    ) {
      // TS/JS object literal properties also surface as Property symbols.
      // Only treat them as declarations when nested under a real type container.
      if (!parents.some(parent => isTypeLikeContainer(parent.kind))) {
        continue;
      }
      // Only classify as FieldDeclaration if ref is in the type portion (before `=`)
      const eqIdx = line.indexOf('=', sym.selectionRange.end.character);
      if (eqIdx === -1 || pos.character < eqIdx) return true;
    }
  }
  return false;
}

export function classifyUsageType(
  refs: ClassifiedReference[],
  symbolsByFile: Map<string, vscode.DocumentSymbol[]>,
): void {
  // Pre-flatten symbols per file to avoid recomputing per reference
  const flatCache = new Map<string, FlattenedSymbol[]>();
  for (const [key, syms] of symbolsByFile) {
    flatCache.set(key, flattenSymbols(syms));
  }

  for (const ref of refs) {
    if (
      ref.category !== ReferenceCategory.ReadAccess &&
      ref.category !== ReferenceCategory.WriteAccess
    ) {
      continue;
    }

    const line = ref.lineText;
    const start = ref.location.range.start.character;
    const end = ref.location.range.end.character;

    // 1. Import — highest priority, very reliable
    if (isImport(line)) {
      ref.category = ReferenceCategory.Import;
      continue;
    }

    // 2. Instantiation — `new SymbolName`
    if (isInstantiation(line, start)) {
      ref.category = ReferenceCategory.Instantiation;
      continue;
    }

    // 3. Field / Property declaration — via DocumentSymbol, type portion only
    const fileKey = ref.location.uri.toString();
    const flat = flatCache.get(fileKey);
    if (flat && isInFieldTypeAnnotation(ref, flat)) {
      ref.category = ReferenceCategory.FieldDeclaration;
      continue;
    }

    // 4. Parameter type — text heuristic (inside function signature with unmatched `(`)
    if (isParameterType(line, start)) {
      ref.category = ReferenceCategory.ParameterDeclaration;
      continue;
    }

    // 5. Return type — text heuristic
    if (isReturnType(line, start, end)) {
      ref.category = ReferenceCategory.ReturnType;
    }
  }
}
