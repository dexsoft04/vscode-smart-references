import * as vscode from 'vscode';
import { WorkspaceLanguageId } from './WorkspaceLanguage';

export type ProtoSemanticKind =
  | 'type'
  | 'service'
  | 'field'
  | 'callable'
  | 'value'
  | 'unknown';

export type ProtoSyntax = 'proto2' | 'proto3' | 'unknown';
export type ProtoFieldLabel = 'required' | 'optional' | 'repeated' | 'none';
export type ProtoFieldTypeKind = 'scalar' | 'custom' | 'map' | 'unknown';

export interface ProtoSymbolContext {
  rawName: string;
  semanticKind: ProtoSemanticKind;
  range: vscode.Range;
  containerName?: string;
  syntax?: ProtoSyntax;
  fieldLabel?: ProtoFieldLabel;
  inOneof?: boolean;
  fieldTypeKind?: ProtoFieldTypeKind;
}

export interface ProtoFileMetadata {
  syntax: ProtoSyntax;
  protoPackage?: string;
  goPackage?: string;
  javaPackage?: string;
  csharpNamespace?: string;
}

interface TokenMatch {
  text: string;
  start: number;
  end: number;
  kind: ProtoSemanticKind;
  containerName?: string;
  fieldLabel?: ProtoFieldLabel;
  inOneof?: boolean;
  fieldTypeKind?: ProtoFieldTypeKind;
}

const TYPE_CHARS_RE = /[A-Za-z0-9_.]/;
const SCALAR_TYPES = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64',
  'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64',
  'bool', 'string', 'bytes',
]);

export function isProtoFile(uri: vscode.Uri): boolean {
  return uri.fsPath.endsWith('.proto');
}

export function findProtoSymbolAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
): ProtoSymbolContext | undefined {
  const metadata = parseProtoFileMetadata(document);
  const lineText = document.lineAt(position.line).text;
  const column = position.character;
  const token = findBestToken(document, position.line, lineText, column, findEnclosingEnumName(document, position.line));
  if (!token) return undefined;
  return {
    rawName: token.text,
    semanticKind: token.kind,
    range: new vscode.Range(
      new vscode.Position(position.line, token.start),
      new vscode.Position(position.line, token.end),
    ),
    containerName: token.containerName,
    syntax: metadata.syntax,
    fieldLabel: token.fieldLabel,
    inOneof: token.inOneof,
    fieldTypeKind: token.fieldTypeKind,
  };
}

export function parseProtoFileMetadata(document: vscode.TextDocument): ProtoFileMetadata {
  let syntax: ProtoSyntax = 'unknown';
  let protoPackage: string | undefined;
  let goPackage: string | undefined;
  let javaPackage: string | undefined;
  let csharpNamespace: string | undefined;

  for (let i = 0; i < document.lineCount; i++) {
    const text = document.lineAt(i).text;
    if (syntax === 'unknown') {
      const match = /^\s*syntax\s*=\s*"([^"]+)"/.exec(text);
      if (match && (match[1] === 'proto2' || match[1] === 'proto3')) syntax = match[1];
    }
    if (!protoPackage) {
      const match = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/.exec(text);
      if (match) protoPackage = match[1];
    }
    if (!goPackage) {
      const match = /^\s*option\s+go_package\s*=\s*"([^"]+)"/.exec(text);
      if (match) goPackage = match[1];
    }
    if (!javaPackage) {
      const match = /^\s*option\s+java_package\s*=\s*"([^"]+)"/.exec(text);
      if (match) javaPackage = match[1];
    }
    if (!csharpNamespace) {
      const match = /^\s*option\s+csharp_namespace\s*=\s*"([^"]+)"/.exec(text);
      if (match) csharpNamespace = match[1];
    }
  }

  return {
    syntax,
    protoPackage,
    goPackage,
    javaPackage,
    csharpNamespace,
  };
}

export function createProtoPackageHints(
  metadata: ProtoFileMetadata,
  language: WorkspaceLanguageId,
  rawName?: string,
): string[] {
  const hints: string[] = [];
  const qualifiedPackage = extractQualifiedPackage(rawName);
  if (qualifiedPackage) {
    hints.push(qualifiedPackage);
  }

  if (metadata.protoPackage) {
    hints.push(metadata.protoPackage);
  }

  switch (language) {
    case 'go':
      if (metadata.goPackage) {
        const importPath = extractGoPackageImportPath(metadata.goPackage);
        if (importPath) hints.push(importPath);
        const alias = extractGoPackageAlias(metadata.goPackage);
        if (alias) hints.push(alias);
      }
      break;
    case 'java':
    case 'kotlin':
    case 'javascript':
    case 'typescript':
      if (metadata.javaPackage) hints.push(metadata.javaPackage);
      break;
    case 'csharp':
      if (metadata.csharpNamespace) hints.push(metadata.csharpNamespace);
      break;
    default:
      break;
  }

  return uniqueAliases(
    hints.flatMap(hint => {
      const normalized = stripLeadingDot(hint.trim());
      if (!normalized) return [];
      const last = lastSegment(normalized);
      return [normalized, normalized.replace(/\//g, '.'), last];
    }),
  );
}

interface AliasParams {
  raw: string;
  snake: string;
  camel: string;
  pascal: string;
  context: Partial<ProtoSymbolContext>;
}

interface ProtoLanguageRule {
  field(p: AliasParams): string[];
  service(p: AliasParams): string[];
  callable(p: AliasParams): string[];
  enumValue(p: AliasParams): string[];
  generic(p: AliasParams): string[];
}

const GO_RULE: ProtoLanguageRule = {
  field: ({ pascal }) => [pascal, `Get${pascal}`],
  service: ({ pascal }) => [
    pascal, `${pascal}Client`, `${pascal}Server`,
    `Unimplemented${pascal}Server`, `Unsafe${pascal}Server`,
    `Register${pascal}Server`, `New${pascal}Client`,
  ],
  callable: ({ pascal }) => [pascal],
  enumValue: ({ raw, pascal }) => [raw, pascal],
  generic: ({ pascal }) => [pascal, `Get${pascal}`],
};

const JAVA_RULE: ProtoLanguageRule = {
  field: ({ camel, pascal, context }) => accessorAliases(camel, pascal, supportsPresence(context)),
  service: ({ pascal }) => [
    pascal, `${pascal}Grpc`, `${pascal}Stub`,
    `${pascal}BlockingStub`, `${pascal}FutureStub`, `${pascal}ImplBase`,
  ],
  callable: ({ camel, pascal }) => [camel, pascal],
  enumValue: ({ raw, pascal }) => [raw, pascal],
  generic: ({ camel, pascal, context }) => accessorAliases(camel, pascal, supportsPresence(context)),
};

const KOTLIN_RULE: ProtoLanguageRule = {
  field: ({ camel, pascal, context }) => accessorAliases(camel, pascal, supportsPresence(context)),
  service: ({ pascal }) => [
    pascal, `${pascal}Grpc`, `${pascal}GrpcKt`, `${pascal}Stub`,
    `${pascal}CoroutineStub`, `${pascal}CoroutineImplBase`,
  ],
  callable: ({ camel, pascal }) => [camel, pascal],
  enumValue: ({ raw, pascal }) => [raw, pascal],
  generic: ({ camel, pascal, context }) => accessorAliases(camel, pascal, supportsPresence(context)),
};

const JS_TS_RULE: ProtoLanguageRule = {
  field: ({ camel, pascal, context }) => accessorAliases(camel, pascal, supportsPresence(context)),
  service: ({ camel, pascal }) => [
    pascal, camel, `${pascal}Client`, `${pascal}PromiseClient`,
    `${pascal}Service`, `I${pascal}Service`,
  ],
  callable: ({ camel, pascal }) => [camel, pascal],
  enumValue: ({ raw, pascal }) => [raw, pascal],
  generic: ({ camel, pascal, context }) => accessorAliases(camel, pascal, supportsPresence(context)),
};

const CSHARP_RULE: ProtoLanguageRule = {
  field: ({ pascal }) => [pascal],
  service: ({ pascal }) => [pascal, `${pascal}Client`, `${pascal}Base`, `BindService`],
  callable: ({ pascal }) => [pascal],
  enumValue: ({ raw, pascal, context }) => {
    const stripped = stripEnumPrefix(raw, context.containerName);
    const strippedPascal = toPascalCase(stripped);
    return [raw, stripped, strippedPascal, pascal];
  },
  generic: ({ pascal }) => [pascal, `Get${pascal}`],
};

const PYTHON_RULE: ProtoLanguageRule = {
  field: ({ snake }) => [snake],
  service: ({ pascal }) => [
    pascal, `${pascal}Stub`, `${pascal}Servicer`,
    `add_${pascal}Servicer_to_server`,
  ],
  callable: ({ camel, pascal }) => [camel, pascal],
  enumValue: ({ raw, pascal }) => [raw, pascal],
  generic: ({ snake, pascal }) => [snake, pascal],
};

const RUST_RULE: ProtoLanguageRule = {
  field: ({ snake, pascal }) => [snake, pascal],
  service: ({ pascal }) => [snakeServiceModule(pascal), pascal, `${pascal}Client`, `${pascal}Server`],
  callable: ({ camel, pascal }) => [camel, pascal],
  enumValue: ({ raw, pascal }) => [raw, pascal],
  generic: ({ snake, pascal }) => [snake, pascal],
};

const DEFAULT_RULE: ProtoLanguageRule = {
  field: ({ snake, camel, pascal }) => [snake, camel, pascal],
  service: ({ camel, pascal }) => [
    pascal, camel, `${pascal}Client`, `${pascal}Server`, `${pascal}Service`,
  ],
  callable: ({ camel, pascal }) => [camel, pascal],
  enumValue: ({ raw, pascal }) => [raw, pascal],
  generic: ({ snake, camel, pascal }) => [snake, camel, pascal, `Get${pascal}`, `get${pascal}`],
};

const LANGUAGE_RULES = new Map<WorkspaceLanguageId, ProtoLanguageRule>([
  ['go', GO_RULE],
  ['java', JAVA_RULE],
  ['kotlin', KOTLIN_RULE],
  ['javascript', JS_TS_RULE],
  ['typescript', JS_TS_RULE],
  ['csharp', CSHARP_RULE],
  ['python', PYTHON_RULE],
  ['rust', RUST_RULE],
]);

function getLanguageRule(language: WorkspaceLanguageId): ProtoLanguageRule {
  return LANGUAGE_RULES.get(language) ?? DEFAULT_RULE;
}

export function createProtoSearchAliases(
  rawInput: string,
  language: WorkspaceLanguageId,
  semanticKind: ProtoSemanticKind = 'unknown',
  context: Partial<ProtoSymbolContext> = {},
): string[] {
  const raw = stripLeadingDot(rawInput.trim());
  if (!raw) return [];

  const baseName = lastSegment(raw);
  const snake = toSnakeCase(baseName);
  const camel = toCamelCase(baseName);
  const pascal = toPascalCase(baseName);
  const aliases: string[] = [raw, baseName];

  const rule = getLanguageRule(language);
  const params: AliasParams = { raw, snake, camel, pascal, context };

  switch (semanticKind) {
    case 'type':
      aliases.push(pascal, camel);
      break;
    case 'service':
      aliases.push(...rule.service(params));
      break;
    case 'field':
      aliases.push(...rule.field(params));
      break;
    case 'callable':
      aliases.push(...rule.callable(params));
      break;
    case 'value':
      aliases.push(...rule.enumValue(params));
      break;
    default:
      aliases.push(...rule.generic(params));
      break;
  }

  return uniqueAliases(aliases);
}

function uniqueAliases(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function findBestToken(
  document: vscode.TextDocument,
  lineNumber: number,
  line: string,
  column: number,
  enumName?: string,
): TokenMatch | undefined {
  const inOneof = isInsideOneof(document, lineNumber);
  const candidates = [
    ...findDeclarationTokens(line),
    ...findExtendTokens(line),
    ...findFieldTokens(line, inOneof),
    ...findGroupTokens(line),
    ...findRpcTokens(line),
    ...findEnumValueTokens(line, enumName),
  ];
  return candidates.find(token => column >= token.start && column <= token.end);
}

function findDeclarationTokens(line: string): TokenMatch[] {
  const tokens: TokenMatch[] = [];
  const decls: Array<{ regex: RegExp; kind: ProtoSemanticKind }> = [
    { regex: /^\s*message\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: 'type' },
    { regex: /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: 'type' },
    { regex: /^\s*service\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: 'service' },
    { regex: /^\s*oneof\s+([A-Za-z_][A-Za-z0-9_]*)\b/, kind: 'field' },
  ];

  for (const decl of decls) {
    const match = decl.regex.exec(line);
    if (!match) continue;
    const token = match[1];
    const start = line.indexOf(token, match.index);
    tokens.push({ text: token, start, end: start + token.length, kind: decl.kind });
  }

  return tokens;
}

function findExtendTokens(line: string): TokenMatch[] {
  const match = /^\s*extend\s+([A-Za-z_.][A-Za-z0-9_.]*)\s*\{/.exec(line);
  if (!match) return [];
  const token = match[1];
  const start = line.indexOf(token, match.index);
  return [{ text: normalizeTypeName(token), start, end: start + token.length, kind: 'type', fieldTypeKind: 'custom' }];
}

function findFieldTokens(line: string, inOneof: boolean): TokenMatch[] {
  const match = /^\s*(?:(required|optional|repeated)\s+)?(map\s*<[^>]+>|[A-Za-z_.][A-Za-z0-9_.<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+/.exec(line);
  if (!match) return [];

  const [full, rawLabel, typeName, fieldName] = match;
  const base = match.index + full.indexOf(typeName);
  const fieldStart = match.index + full.lastIndexOf(fieldName);
  const fieldLabel = (rawLabel as ProtoFieldLabel | undefined) ?? 'none';
  const fieldTypeKind = detectFieldTypeKind(typeName);
  return [
    {
      text: normalizeTypeName(typeName),
      start: findTypeTokenStart(line, base, typeName),
      end: findTypeTokenEnd(line, base, typeName),
      kind: 'type',
      fieldLabel,
      inOneof,
      fieldTypeKind,
    },
    {
      text: fieldName,
      start: fieldStart,
      end: fieldStart + fieldName.length,
      kind: 'field',
      fieldLabel,
      inOneof,
      fieldTypeKind,
    },
  ];
}

function findGroupTokens(line: string): TokenMatch[] {
  const match = /^\s*(?:(required|optional|repeated)\s+)?group\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+\s*\{/.exec(line);
  if (!match) return [];
  const [, rawLabel, groupName] = match;
  const start = line.indexOf(groupName, match.index);
  return [{
    text: groupName,
    start,
    end: start + groupName.length,
    kind: 'type',
    fieldLabel: (rawLabel as ProtoFieldLabel | undefined) ?? 'none',
    fieldTypeKind: 'custom',
  }];
}

function findRpcTokens(line: string): TokenMatch[] {
  const match = /^\s*rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*([.)A-Za-z_][A-Za-z0-9_.]*)\s*\)\s+returns\s*\(\s*([.)A-Za-z_][A-Za-z0-9_.]*)\s*\)/.exec(line);
  if (!match) return [];

  const [full, rpcName, requestType, responseType] = match;
  const offset = match.index;
  const rpcStart = offset + full.indexOf(rpcName);
  const requestStart = offset + full.indexOf(requestType);
  const responseStart = offset + full.lastIndexOf(responseType);
  return [
    { text: rpcName, start: rpcStart, end: rpcStart + rpcName.length, kind: 'callable' },
    {
      text: normalizeTypeName(requestType),
      start: requestStart,
      end: requestStart + requestType.length,
      kind: 'type',
    },
    {
      text: normalizeTypeName(responseType),
      start: responseStart,
      end: responseStart + responseType.length,
      kind: 'type',
    },
  ];
}

function findEnumValueTokens(line: string, enumName?: string): TokenMatch[] {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*-?\d+/.exec(line);
  if (!match) return [];
  const token = match[1];
  const start = line.indexOf(token, match.index);
  return [{
    text: token,
    start,
    end: start + token.length,
    kind: 'value',
    containerName: enumName,
  }];
}

function findEnclosingEnumName(document: vscode.TextDocument, line: number): string | undefined {
  return findEnclosingBlockName(document, line, 'enum');
}

function isInsideOneof(document: vscode.TextDocument, line: number): boolean {
  return !!findEnclosingBlockName(document, line, 'oneof');
}

function findEnclosingBlockName(
  document: vscode.TextDocument,
  line: number,
  keyword: 'enum' | 'oneof',
): string | undefined {
  let depth = 0;
  for (let current = line; current >= 0; current--) {
    const text = document.lineAt(current).text;
    depth += countChar(text, '}');
    depth -= countChar(text, '{');
    if (depth > 0) continue;
    const match = new RegExp(`^\\s*${keyword}\\s+([A-Za-z_][A-Za-z0-9_]*)\\b`).exec(text);
    if (match) return match[1];
  }
  return undefined;
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === char) count++;
  }
  return count;
}

function stripLeadingDot(value: string): string {
  return value.startsWith('.') ? value.slice(1) : value;
}

function extractQualifiedPackage(value?: string): string | undefined {
  if (!value) return undefined;
  const cleaned = stripLeadingDot(value.trim());
  if (!cleaned.includes('.')) return undefined;
  const parts = cleaned.split('.');
  parts.pop();
  return parts.join('.');
}

function extractGoPackageAlias(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes(';')) {
    const alias = trimmed.split(';').pop()?.trim();
    return alias || undefined;
  }
  const normalized = trimmed.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || undefined;
}

function extractGoPackageImportPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const pathPart = trimmed.split(';')[0]?.trim();
  if (!pathPart || isRelativeGoPackagePath(pathPart)) return undefined;
  return pathPart || undefined;
}

function isRelativeGoPackagePath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('.');
}

function lastSegment(value: string): string {
  const cleaned = stripLeadingDot(value);
  const parts = cleaned.split('.');
  return parts[parts.length - 1] ?? cleaned;
}

function normalizeTypeName(value: string): string {
  if (value.startsWith('map<')) return value;
  return lastSegment(value);
}

function findTypeTokenStart(line: string, base: number, token: string): number {
  let start = base;
  while (start < line.length && !TYPE_CHARS_RE.test(line[start])) start++;
  if (token.startsWith('.') && line[start] !== '.') start--;
  return start;
}

function findTypeTokenEnd(line: string, base: number, token: string): number {
  let end = base;
  while (end < line.length && TYPE_CHARS_RE.test(line[end])) end++;
  return end;
}

function stripEnumPrefix(value: string, containerName?: string): string {
  const normalized = value.trim();
  if (!containerName) return normalized;
  const enumPrefix = toSnakeCase(containerName).toUpperCase();
  const upper = normalized.toUpperCase();
  if (upper.startsWith(enumPrefix + '_')) {
    return normalized.slice(enumPrefix.length + 1);
  }
  return normalized;
}

function accessorAliases(camel: string, pascal: string, includeHazzer: boolean): string[] {
  const aliases = [camel, `get${pascal}`, `set${pascal}`, `clear${pascal}`];
  if (includeHazzer) aliases.push(`has${pascal}`);
  return aliases;
}

function supportsPresence(context: Partial<ProtoSymbolContext>): boolean {
  if (context.inOneof) return true;
  if (context.syntax === 'proto2') {
    return context.fieldLabel !== 'repeated';
  }
  if (context.syntax === 'proto3') {
    if (context.fieldLabel === 'optional') return true;
    return context.fieldTypeKind === 'custom';
  }
  return true;
}

function detectFieldTypeKind(typeName: string): ProtoFieldTypeKind {
  const normalized = typeName.trim();
  if (normalized.startsWith('map<')) return 'map';
  const base = lastSegment(normalized);
  return SCALAR_TYPES.has(base) ? 'scalar' : 'custom';
}

function snakeServiceModule(value: string): string {
  return toSnakeCase(value);
}

export function toSnakeCase(value: string): string {
  const raw = lastSegment(value).replace(/-/g, '_');
  const withBoundary = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  return withBoundary.replace(/__+/g, '_').toLowerCase();
}

export function toCamelCase(value: string): string {
  const snake = toSnakeCase(value);
  return snake.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}

export function toPascalCase(value: string): string {
  const camel = toCamelCase(value);
  if (!camel) return camel;
  return camel[0].toUpperCase() + camel.slice(1);
}
