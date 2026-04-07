import * as path from 'path';
import * as vscode from 'vscode';
import {
  createProtoSearchAliases,
  createProtoPackageHints,
  findProtoSymbolAtPosition,
  isProtoFile,
  parseProtoFileMetadata,
  ProtoFileMetadata,
  ProtoSemanticKind,
} from './ProtoSymbolMapper';
import { detectMainWorkspaceLanguage, WorkspaceLanguageProfile } from './WorkspaceLanguage';
import { MAX_PROTO_FILTERED_SYMBOLS } from './constants';

interface SearchPlan {
  aliases: string[];
  semanticKind: ProtoSemanticKind;
  language: WorkspaceLanguageProfile;
  packageHints: string[];
  contextUri?: vscode.Uri;
}

interface ScoredSymbol {
  symbol: vscode.SymbolInformation;
  score: number;
  packageScore: number;
}

export interface ProtoReferenceBundle {
  references: vscode.Location[];
  definitions: vscode.Location[];
  implementations: vscode.Location[];
}

export class ProtoWorkspaceNavigator {
  constructor(private readonly log: vscode.OutputChannel) {}

  isProtoUri(uri: vscode.Uri): boolean {
    return isProtoFile(uri);
  }

  async searchSymbolsForQuery(
    contextUri: vscode.Uri | undefined,
    rawQuery: string,
  ): Promise<{ symbols: vscode.SymbolInformation[]; aliases: string[] }> {
    const language = await detectMainWorkspaceLanguage();
    if (language.id === 'unknown') {
      return { symbols: [], aliases: [] };
    }
    const packageHints = contextUri && isProtoFile(contextUri)
      ? await this.loadPackageHints(contextUri, language, rawQuery)
      : [];
    const aliases = createProtoSearchAliases(rawQuery, language.id, 'unknown', {});
    const symbols = await this.searchSymbolsByPlan({
      aliases,
      semanticKind: 'unknown',
      language,
      packageHints,
      contextUri,
    });
    return { symbols, aliases };
  }

  async findDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const bundle = await this.resolveReferenceBundle(uri, position, true);
    return bundle.definitions;
  }

  async findReferences(uri: vscode.Uri, position: vscode.Position, includeDeclaration = true): Promise<vscode.Location[]> {
    const bundle = await this.resolveReferenceBundle(uri, position, includeDeclaration);
    return bundle.references;
  }

  async findImplementations(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const bundle = await this.resolveReferenceBundle(uri, position, true);
    return bundle.implementations;
  }

  async resolveReferenceBundle(
    uri: vscode.Uri,
    position: vscode.Position,
    includeDeclaration = true,
  ): Promise<ProtoReferenceBundle> {
    const document = await vscode.workspace.openTextDocument(uri);
    const context = findProtoSymbolAtPosition(document, position);
    if (!context) {
      return { references: [], definitions: [], implementations: [] };
    }
    const metadata = parseProtoFileMetadata(document);

    const anchors = await this.resolveAnchorsWithContext(uri, document, context, metadata);
    const declaration = new vscode.Location(uri, context.range);
    const definitions = dedupeLocations([
      declaration,
      ...anchors.map(item => item.location),
    ]);

    const [referenceResults, implementationResults, protoRefs] = await Promise.all([
      Promise.all(
        anchors.slice(0, 5).map(anchor =>
          vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            anchor.location.uri,
            anchor.location.range.start,
          ).then(items => items ?? [], () => []),
        ),
      ),
      Promise.all(
        anchors.slice(0, 5).map(anchor =>
          vscode.commands.executeCommand<unknown>(
            'vscode.executeImplementationProvider',
            anchor.location.uri,
            anchor.location.range.start,
          ).then(raw => toLocations(raw), () => []),
        ),
      ),
      findProtoTextReferences(uri, position, context.rawName, metadata),
    ]);

    let references = dedupeLocations([
      ...(includeDeclaration ? [declaration] : []),
      ...referenceResults.flat(),
      ...protoRefs,
    ]);
    if (!includeDeclaration) {
      const anchorKeys = new Set(anchors.map(anchor => locationKey(anchor.location)));
      references = references.filter(location => !anchorKeys.has(locationKey(location)));
    }

    return {
      references,
      definitions,
      implementations: dedupeLocations(implementationResults.flat()),
    };
  }

  private async resolveAnchorsWithContext(
    uri: vscode.Uri,
    document: vscode.TextDocument,
    context: ReturnType<typeof findProtoSymbolAtPosition>,
    metadata: ProtoFileMetadata,
  ): Promise<vscode.SymbolInformation[]> {
    if (!context) {
      this.log.appendLine('[proto] no symbol resolved at cursor');
      return [];
    }

    const language = await detectMainWorkspaceLanguage();
    if (language.id === 'unknown') {
      this.log.appendLine(`[proto] main project language unresolved for symbol "${context.rawName}"`);
      return [];
    }

    const aliases = createProtoSearchAliases(
      context.rawName,
      language.id,
      context.semanticKind,
      context,
    );
    const packageHints = createProtoPackageHints(
      metadata,
      language.id,
      context.rawName,
    );
    const symbols = await this.searchSymbolsByPlan({
      aliases,
      semanticKind: context.semanticKind,
      language,
      packageHints,
      contextUri: uri,
    });
    this.log.appendLine(`[proto] resolved "${context.rawName}" (${context.semanticKind}) -> aliases=[${aliases.join(', ')}] packageHints=[${packageHints.join(', ')}] results=${symbols.length}`);
    return symbols.slice(0, 10);
  }

  private async loadPackageHints(
    uri: vscode.Uri,
    language: WorkspaceLanguageProfile,
    rawName?: string,
  ): Promise<string[]> {
    const document = await vscode.workspace.openTextDocument(uri);
    return createProtoPackageHints(parseProtoFileMetadata(document), language.id, rawName);
  }

  private async searchSymbolsByPlan(plan: SearchPlan): Promise<vscode.SymbolInformation[]> {
    const queryAliases = plan.aliases.filter(alias => alias.length >= 2).slice(0, 8);
    if (queryAliases.length === 0) return [];
    const lookupQueries = buildWorkspaceSymbolQueries(queryAliases, plan.packageHints);

    const rawResults = await Promise.all(
      lookupQueries.map(alias =>
        vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          alias,
        ).then(items => items ?? [], () => []),
      ),
    );

    let filtered = dedupeSymbols(rawResults.flat()).filter(symbol => {
      if (symbol.location.uri.fsPath.endsWith('.proto')) return false;
      if (plan.language.extensions.length === 0) return true;
      return plan.language.extensions.some(ext => symbol.location.uri.fsPath.endsWith(ext));
    }).filter(symbol => symbolKindMatches(symbol.kind, plan.semanticKind));

    if (filtered.length === 0) {
      const fallback = await this.searchSymbolsFromDocuments(plan, queryAliases);
      if (fallback.length > 0) {
        this.log.appendLine(`[proto] workspace symbol empty, document fallback matched=${fallback.length}`);
        filtered = fallback;
      }
    }

    const scored = filtered
      .map(symbol => {
        const packageScore = scorePackageAffinity(symbol, plan.packageHints, plan.contextUri);
        return {
          symbol,
          packageScore,
          score: scoreSymbol(symbol, queryAliases, plan.language) + packageScore,
        };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return keepStrongest(scored, plan.packageHints.length > 0).map(item => item.symbol);
  }

  private async searchSymbolsFromDocuments(
    plan: SearchPlan,
    aliases: string[],
  ): Promise<vscode.SymbolInformation[]> {
    const candidateFiles = await findCandidateFiles(aliases, plan.language.extensions);
    if (candidateFiles.length === 0) return [];

    const symbolGroups = await Promise.all(
      candidateFiles.slice(0, 40).map(uri => loadDocumentSymbols(uri)),
    );

    return dedupeSymbols(symbolGroups.flat()).filter(symbol => {
      if (symbol.location.uri.fsPath.endsWith('.proto')) return false;
      if (!symbolKindMatches(symbol.kind, plan.semanticKind)) return false;
      return matchesAnyAlias(symbol.name, aliases);
    });
  }
}

async function findProtoTextReferences(
  sourceUri: vscode.Uri,
  position: vscode.Position,
  rawName: string,
  sourceMetadata: ProtoFileMetadata,
): Promise<vscode.Location[]> {
  const shortName = lastSegment(rawName);
  const samePackageOnlyName = shortName;
  const qualifiedNames = uniqueStrings([
    stripLeadingDot(rawName),
    sourceMetadata.protoPackage ? `${sourceMetadata.protoPackage}.${shortName}` : '',
  ]);

  const files = await vscode.workspace.findFiles(
    '**/*.proto',
    '**/{node_modules,vendor,dist,out}/**',
  );
  const locations: vscode.Location[] = [];

  await Promise.all(files.map(async file => {
    const document = await vscode.workspace.openTextDocument(file);
    const metadata = parseProtoFileMetadata(document);
    const samePackage = metadata.protoPackage === sourceMetadata.protoPackage;
    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
      const text = document.lineAt(lineIndex).text;

      for (const qualified of qualifiedNames) {
        for (const range of findTokenRanges(lineIndex, text, qualified)) {
          if (isSourceToken(sourceUri, position, file, lineIndex, range)) continue;
          locations.push(new vscode.Location(file, range));
        }
      }

      if (!samePackage) continue;
      for (const range of findTokenRanges(lineIndex, text, samePackageOnlyName)) {
        if (isPartOfQualifiedProtoReference(text, range.start.character)) continue;
        if (isSourceToken(sourceUri, position, file, lineIndex, range)) continue;
        locations.push(new vscode.Location(file, range));
      }
    }
  }));

  return dedupeLocations(locations);
}

function buildWorkspaceSymbolQueries(
  aliases: string[],
  packageHints: string[],
): string[] {
  const queries: string[] = [...aliases];
  const scopedPackages = uniqueStrings(
    packageHints.flatMap(hint => {
      const normalized = normalizePackageText(hint);
      if (!normalized) return [];
      const tail = packageTail(normalized);
      return tail && tail !== normalized ? [normalized, tail] : [normalized];
    }),
  ).slice(0, 4);

  for (const pkg of scopedPackages) {
    for (const alias of aliases.slice(0, 4)) {
      queries.push(`${pkg}.${alias}`);
      queries.push(`${pkg} ${alias}`);
    }
  }

  return uniqueStrings(queries).slice(0, 16);
}

function dedupeSymbols(symbols: vscode.SymbolInformation[]): vscode.SymbolInformation[] {
  const result: vscode.SymbolInformation[] = [];
  const seen = new Set<string>();
  for (const symbol of symbols) {
    const key = `${symbol.name}\0${locationKey(symbol.location)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(symbol);
  }
  return result;
}

async function findCandidateFiles(
  aliases: string[],
  extensions: string[],
): Promise<vscode.Uri[]> {
  const include = buildExtensionGlob(extensions) ?? '**/*';
  const files = await vscode.workspace.findFiles(
    include,
    '**/{node_modules,vendor,dist,out,.git,target,coverage}/**',
    200,
  );
  const loweredAliases = aliases.slice(0, 4).map(alias => alias.toLowerCase());
  const candidates: vscode.Uri[] = [];

  for (const file of files) {
    try {
      const document = await vscode.workspace.openTextDocument(file);
      const text = document.getText().toLowerCase();
      if (!loweredAliases.some(alias => text.includes(alias))) continue;
      candidates.push(file);
      if (candidates.length >= 40) break;
    } catch {
      // ignore unreadable file
    }
  }

  return candidates;
}

async function loadDocumentSymbols(uri: vscode.Uri): Promise<vscode.SymbolInformation[]> {
  try {
    const raw = await vscode.commands.executeCommand<unknown>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const first = raw[0];
    if (first instanceof vscode.SymbolInformation) {
      return raw.filter((item): item is vscode.SymbolInformation => item instanceof vscode.SymbolInformation);
    }
    return flattenDocumentSymbols(uri, raw as vscode.DocumentSymbol[]);
  } catch {
    return [];
  }
}

function flattenDocumentSymbols(
  uri: vscode.Uri,
  symbols: vscode.DocumentSymbol[],
  parents: string[] = [],
): vscode.SymbolInformation[] {
  const result: vscode.SymbolInformation[] = [];
  for (const symbol of symbols) {
    const containerName = parents[parents.length - 1] ?? path.basename(uri.fsPath);
    result.push(new vscode.SymbolInformation(
      symbol.name,
      symbol.kind,
      containerName,
      new vscode.Location(uri, symbol.selectionRange),
    ));
    result.push(...flattenDocumentSymbols(uri, symbol.children, [...parents, symbol.name]));
  }
  return result;
}

function buildExtensionGlob(extensions: string[]): string | undefined {
  const normalized = uniqueStrings(
    extensions
      .map(ext => ext.startsWith('.') ? ext.slice(1) : ext)
      .filter(Boolean),
  );
  if (normalized.length === 0) return undefined;
  if (normalized.length === 1) return `**/*.${normalized[0]}`;
  return `**/*.{${normalized.join(',')}}`;
}

function matchesAnyAlias(name: string, aliases: string[]): boolean {
  const lower = name.toLowerCase();
  return aliases.some(alias => {
    const query = alias.toLowerCase();
    return lower === query || lower.startsWith(query) || lower.includes(query);
  });
}

function dedupeLocations(locations: vscode.Location[]): vscode.Location[] {
  const result: vscode.Location[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const key = locationKey(location);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(location);
  }
  return result;
}

function scoreSymbol(
  symbol: vscode.SymbolInformation,
  aliases: string[],
  language: WorkspaceLanguageProfile,
): number {
  const name = symbol.name;
  const lower = name.toLowerCase();
  let best = 0;

  for (const alias of aliases) {
    const query = alias.toLowerCase();
    if (lower === query) {
      best = Math.max(best, 5000);
      continue;
    }
    if (lower.startsWith(query)) {
      best = Math.max(best, 4000);
      continue;
    }
    if (lower.includes(query)) {
      best = Math.max(best, 3000);
    }
  }

  if (best === 0) return 0;

  if (language.extensions.some(ext => symbol.location.uri.fsPath.endsWith(ext))) {
    best += 600;
  }

  switch (symbol.kind) {
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.Struct:
    case vscode.SymbolKind.Enum:
      best += 300;
      break;
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Property:
    case vscode.SymbolKind.Field:
      best += 200;
      break;
    default:
      break;
  }

  const base = path.basename(symbol.location.uri.fsPath);
  if (base.includes('.pb.') || base.includes('_pb.') || base.includes('.g.')) {
    best += 100;
  }

  best -= Math.min(name.length, 100);
  return best;
}

function keepStrongest(symbols: ScoredSymbol[], hasPackageHints: boolean): ScoredSymbol[] {
  if (symbols.length === 0) return [];
  if (hasPackageHints) {
    const strongPackageMatches = symbols.filter(item => item.packageScore >= 900);
    if (strongPackageMatches.length > 0) {
      symbols = strongPackageMatches;
    }
  }
  const strongest = symbols[0].score;
  const threshold = strongest >= 5000 ? strongest - 300 : strongest - 1200;
  return symbols.filter(item => item.score >= threshold).slice(0, MAX_PROTO_FILTERED_SYMBOLS);
}

function scorePackageAffinity(
  symbol: vscode.SymbolInformation,
  packageHints: string[],
  contextUri?: vscode.Uri,
): number {
  if (packageHints.length === 0) return contextPathScore(symbol.location.uri, contextUri);

  const haystacks = [
    normalizePackageText(symbol.containerName),
    normalizePackageText(vscode.workspace.asRelativePath(symbol.location.uri)),
    normalizePackageText(path.dirname(symbol.location.uri.fsPath)),
  ].filter(Boolean);

  let best = 0;
  for (const hint of packageHints) {
    const normalizedHint = normalizePackageText(hint);
    if (!normalizedHint) continue;
    const hintTail = packageTail(normalizedHint);
    for (const haystack of haystacks) {
      if (haystack === normalizedHint) {
        best = Math.max(best, 1400);
      } else if (haystack.endsWith('.' + normalizedHint) || haystack.includes('.' + normalizedHint + '.')) {
        best = Math.max(best, 1200);
      } else if (haystack.includes(normalizedHint)) {
        best = Math.max(best, 900);
      } else if (hintTail && packageTail(haystack) === hintTail) {
        best = Math.max(best, 400);
      }
    }
  }

  return best + contextPathScore(symbol.location.uri, contextUri);
}

function contextPathScore(symbolUri: vscode.Uri, contextUri?: vscode.Uri): number {
  if (!contextUri) return 0;
  const symbolDir = path.dirname(symbolUri.fsPath);
  const contextDir = path.dirname(contextUri.fsPath);
  if (symbolDir === contextDir) return 250;
  if (path.dirname(symbolDir) === path.dirname(contextDir)) return 120;
  return 0;
}

function normalizePackageText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/::/g, '.')
    .replace(/\//g, '.')
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '');
}

function packageTail(value: string): string {
  const parts = value.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function symbolKindMatches(kind: vscode.SymbolKind, semanticKind: ProtoSemanticKind): boolean {
  switch (semanticKind) {
    case 'type':
      return [
        vscode.SymbolKind.Class,
        vscode.SymbolKind.Interface,
        vscode.SymbolKind.Struct,
        vscode.SymbolKind.Enum,
        vscode.SymbolKind.TypeParameter,
        vscode.SymbolKind.Namespace,
      ].includes(kind);
    case 'service':
      return [
        vscode.SymbolKind.Class,
        vscode.SymbolKind.Interface,
        vscode.SymbolKind.Struct,
        vscode.SymbolKind.Namespace,
        vscode.SymbolKind.Function,
        vscode.SymbolKind.Method,
      ].includes(kind);
    case 'field':
      return [
        vscode.SymbolKind.Field,
        vscode.SymbolKind.Property,
        vscode.SymbolKind.Variable,
        vscode.SymbolKind.Constant,
        vscode.SymbolKind.Method,
        vscode.SymbolKind.Function,
      ].includes(kind);
    case 'callable':
      return [
        vscode.SymbolKind.Method,
        vscode.SymbolKind.Function,
      ].includes(kind);
    case 'value':
      return [
        vscode.SymbolKind.EnumMember,
        vscode.SymbolKind.Constant,
        vscode.SymbolKind.Field,
        vscode.SymbolKind.Property,
      ].includes(kind);
    default:
      return true;
  }
}

function toLocations(raw: unknown): vscode.Location[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((item): item is vscode.Location => item instanceof vscode.Location);
}

function locationKey(location: vscode.Location): string {
  const start = location.range.start;
  const end = location.range.end;
  return `${location.uri.toString()}:${start.line}:${start.character}:${end.line}:${end.character}`;
}

function findTokenRanges(lineNumber: number, lineText: string, token: string): vscode.Range[] {
  if (!token) return [];
  const escaped = escapeRegExp(token);
  const regex = new RegExp(`(?<![A-Za-z0-9_\\.])${escaped}(?![A-Za-z0-9_])`, 'g');
  const ranges: vscode.Range[] = [];
  for (const match of lineText.matchAll(regex)) {
    const start = match.index ?? -1;
    if (start < 0) continue;
    ranges.push(new vscode.Range(
      new vscode.Position(lineNumber, start),
      new vscode.Position(lineNumber, start + token.length),
    ));
  }
  return ranges;
}

function isPartOfQualifiedProtoReference(lineText: string, startChar: number): boolean {
  return startChar > 0 && lineText[startChar - 1] === '.';
}

function isSourceToken(
  sourceUri: vscode.Uri,
  sourcePosition: vscode.Position,
  candidateUri: vscode.Uri,
  candidateLine: number,
  range: vscode.Range,
): boolean {
  return sourceUri.toString() === candidateUri.toString()
    && sourcePosition.line === candidateLine
    && sourcePosition.character >= range.start.character
    && sourcePosition.character <= range.end.character;
}

function lastSegment(value: string): string {
  const cleaned = stripLeadingDot(value);
  const parts = cleaned.split('.');
  return parts[parts.length - 1] ?? cleaned;
}

function stripLeadingDot(value: string): string {
  return value.startsWith('.') ? value.slice(1) : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
