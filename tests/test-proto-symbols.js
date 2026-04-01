'use strict';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

function stripLeadingDot(value) {
  return value.startsWith('.') ? value.slice(1) : value;
}

function lastSegment(value) {
  const cleaned = stripLeadingDot(value);
  const parts = cleaned.split('.');
  return parts[parts.length - 1] || cleaned;
}

function toSnakeCase(value) {
  const raw = lastSegment(value).replace(/-/g, '_');
  const withBoundary = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  return withBoundary.replace(/__+/g, '_').toLowerCase();
}

function toCamelCase(value) {
  const snake = toSnakeCase(value);
  return snake.replace(/_([a-z0-9])/g, (_m, ch) => ch.toUpperCase());
}

function toPascalCase(value) {
  const camel = toCamelCase(value);
  return camel ? camel[0].toUpperCase() + camel.slice(1) : camel;
}

function stripEnumPrefix(value, containerName) {
  const normalized = value.trim();
  if (!containerName) return normalized;
  const enumPrefix = toSnakeCase(containerName).toUpperCase();
  const upper = normalized.toUpperCase();
  if (upper.startsWith(enumPrefix + '_')) {
    return normalized.slice(enumPrefix.length + 1);
  }
  return normalized;
}

function uniqueAliases(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function extractQualifiedPackage(value) {
  if (!value) return undefined;
  const cleaned = stripLeadingDot(value.trim());
  if (!cleaned.includes('.')) return undefined;
  const parts = cleaned.split('.');
  parts.pop();
  return parts.join('.');
}

function extractGoPackageAlias(value) {
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

function isRelativeGoPackagePath(value) {
  return value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('.');
}

function extractGoPackageImportPath(value) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const pathPart = trimmed.split(';')[0]?.trim();
  if (!pathPart || isRelativeGoPackagePath(pathPart)) return undefined;
  return pathPart || undefined;
}

function createProtoPackageHints(metadata, language, rawName) {
  const hints = [];
  const qualifiedPackage = extractQualifiedPackage(rawName);
  if (qualifiedPackage) hints.push(qualifiedPackage);
  if (metadata.protoPackage) hints.push(metadata.protoPackage);

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

function accessorAliases(camel, pascal, includeHazzer) {
  const aliases = [camel, `get${pascal}`, `set${pascal}`, `clear${pascal}`];
  if (includeHazzer) aliases.push(`has${pascal}`);
  return aliases;
}

function supportsPresence(context) {
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

function genericAliasesForLanguage(language, snake, camel, pascal, context) {
  switch (language) {
    case 'go':
    case 'csharp':
      return [pascal, `Get${pascal}`];
    case 'java':
    case 'kotlin':
    case 'javascript':
    case 'typescript':
      return accessorAliases(camel, pascal, supportsPresence(context));
    case 'python':
    case 'rust':
      return [snake, pascal];
    default:
      return [snake, camel, pascal, `Get${pascal}`, `get${pascal}`];
  }
}

function fieldAliasesForLanguage(language, snake, camel, pascal, context) {
  switch (language) {
    case 'go':
      return [pascal, `Get${pascal}`];
    case 'csharp':
      return [pascal];
    case 'java':
    case 'kotlin':
    case 'javascript':
    case 'typescript':
      return accessorAliases(camel, pascal, supportsPresence(context));
    case 'python':
      return [snake];
    case 'rust':
      return [snake, pascal];
    default:
      return [snake, camel, pascal];
  }
}

function snakeServiceModule(value) {
  return toSnakeCase(value);
}

function serviceAliasesForLanguage(language, camel, pascal) {
  switch (language) {
    case 'go':
      return [
        pascal,
        `${pascal}Client`,
        `${pascal}Server`,
        `Unimplemented${pascal}Server`,
        `Unsafe${pascal}Server`,
        `Register${pascal}Server`,
        `New${pascal}Client`,
      ];
    case 'java':
      return [
        pascal,
        `${pascal}Grpc`,
        `${pascal}Stub`,
        `${pascal}BlockingStub`,
        `${pascal}FutureStub`,
        `${pascal}ImplBase`,
      ];
    case 'kotlin':
      return [
        pascal,
        `${pascal}Grpc`,
        `${pascal}GrpcKt`,
        `${pascal}Stub`,
        `${pascal}CoroutineStub`,
        `${pascal}CoroutineImplBase`,
      ];
    case 'javascript':
    case 'typescript':
      return [
        pascal,
        camel,
        `${pascal}Client`,
        `${pascal}PromiseClient`,
        `${pascal}Service`,
        `I${pascal}Service`,
      ];
    case 'csharp':
      return [
        pascal,
        `${pascal}Client`,
        `${pascal}Base`,
        'BindService',
      ];
    case 'python':
      return [
        pascal,
        `${pascal}Stub`,
        `${pascal}Servicer`,
        `add_${pascal}Servicer_to_server`,
      ];
    case 'rust':
      return [snakeServiceModule(pascal), pascal, `${pascal}Client`, `${pascal}Server`];
    default:
      return [
        pascal,
        camel,
        `${pascal}Client`,
        `${pascal}Server`,
        `${pascal}Service`,
      ];
  }
}

function enumValueAliasesForLanguage(language, raw, pascal, containerName) {
  if (language === 'csharp') {
    const stripped = stripEnumPrefix(raw, containerName);
    const strippedPascal = toPascalCase(stripped);
    return [raw, stripped, strippedPascal, pascal];
  }
  return [raw, pascal];
}

function createProtoSearchAliases(rawInput, language, semanticKind, context = {}) {
  const raw = stripLeadingDot(rawInput.trim());
  const baseName = lastSegment(raw);
  const snake = toSnakeCase(baseName);
  const camel = toCamelCase(baseName);
  const pascal = toPascalCase(baseName);
  const aliases = [raw, baseName];

  switch (semanticKind) {
    case 'type':
      aliases.push(pascal, camel);
      break;
    case 'service':
      aliases.push(...serviceAliasesForLanguage(language, camel, pascal));
      break;
    case 'field':
      aliases.push(...fieldAliasesForLanguage(language, snake, camel, pascal, context));
      break;
    case 'value':
      aliases.push(...enumValueAliasesForLanguage(language, raw, pascal, context.containerName));
      break;
    default:
      aliases.push(...genericAliasesForLanguage(language, snake, camel, pascal, context));
      break;
  }

  return uniqueAliases(aliases);
}

group('proto aliases — Go fields', () => {
  const aliases = createProtoSearchAliases('user_id', 'go', 'field');
  assert(aliases.includes('UserId'), 'Go field maps to PascalCase property');
  assert(aliases.includes('GetUserId'), 'Go field includes generated getter');
  assert(!aliases.includes('userId'), 'Go field does not prefer lower camel case');
});

group('proto aliases — C# fields', () => {
  const aliases = createProtoSearchAliases('display_name', 'csharp', 'field');
  assert(aliases.includes('DisplayName'), 'C# field maps to PascalCase property');
  assert(!aliases.includes('getDisplayName'), 'C# field does not add Java-style getters');
});

group('proto aliases — Java/Kotlin/JS fields', () => {
  for (const language of ['java', 'kotlin', 'javascript', 'typescript']) {
    const aliases = createProtoSearchAliases('display_name', language, 'field', {
      syntax: 'proto2',
      fieldLabel: 'optional',
      fieldTypeKind: 'scalar',
    });
    assert(aliases.includes('displayName'), `${language} field maps to lower camel case`);
    assert(aliases.includes('getDisplayName'), `${language} field includes getter`);
    assert(aliases.includes('setDisplayName'), `${language} field includes setter`);
    assert(aliases.includes('hasDisplayName'), `${language} field includes has* helper`);
    assert(aliases.includes('clearDisplayName'), `${language} field includes clear* helper`);
  }
});

group('proto aliases — Python fields', () => {
  const aliases = createProtoSearchAliases('display_name', 'python', 'field');
  assert(aliases.includes('display_name'), 'Python field keeps snake_case');
  assert(!aliases.includes('displayName'), 'Python field does not add camelCase');
});

group('proto3 scalar fields — no hazzer by default', () => {
  const aliases = createProtoSearchAliases('count', 'typescript', 'field', {
    syntax: 'proto3',
    fieldLabel: 'none',
    fieldTypeKind: 'scalar',
  });
  assert(!aliases.includes('hasCount'), 'proto3 scalar field does not add has* by default');
  assert(aliases.includes('clearCount'), 'proto3 scalar field still keeps clear* helper');
});

group('proto3 optional fields — keep hazzer', () => {
  const aliases = createProtoSearchAliases('count', 'typescript', 'field', {
    syntax: 'proto3',
    fieldLabel: 'optional',
    fieldTypeKind: 'scalar',
  });
  assert(aliases.includes('hasCount'), 'proto3 optional scalar keeps has* helper');
});

group('proto3 oneof fields — keep hazzer', () => {
  const aliases = createProtoSearchAliases('choice', 'typescript', 'field', {
    syntax: 'proto3',
    fieldLabel: 'none',
    fieldTypeKind: 'scalar',
    inOneof: true,
  });
  assert(aliases.includes('hasChoice'), 'proto3 oneof field keeps has* helper');
});

group('proto aliases — message/type names', () => {
  const aliases = createProtoSearchAliases('user_profile', 'go', 'type');
  assert(aliases.includes('UserProfile'), 'type aliases include PascalCase');
  assert(aliases.includes('userProfile'), 'type aliases also include camelCase fallback');
});

group('proto aliases — service names', () => {
  const goAliases = createProtoSearchAliases('Transport', 'go', 'service');
  assert(goAliases.includes('TransportClient'), 'Go service includes client interface alias');
  assert(goAliases.includes('TransportServer'), 'Go service includes server interface alias');
  assert(goAliases.includes('RegisterTransportServer'), 'Go service includes register helper alias');

  const javaAliases = createProtoSearchAliases('Transport', 'java', 'service');
  assert(javaAliases.includes('TransportGrpc'), 'Java service includes grpc outer class alias');
  assert(javaAliases.includes('TransportBlockingStub'), 'Java service includes blocking stub alias');

  const pythonAliases = createProtoSearchAliases('Transport', 'python', 'service');
  assert(pythonAliases.includes('TransportStub'), 'Python service includes stub alias');
  assert(pythonAliases.includes('add_TransportServicer_to_server'), 'Python service includes registration helper alias');
});

group('proto package hints — ignore relative go_package import path', () => {
  const hints = createProtoPackageHints({
    syntax: 'proto3',
    protoPackage: 'go.micro.transport.grpc',
    goPackage: '/proto;transport',
  }, 'go', 'Transport');
  assert(!hints.includes('/proto'), 'relative go_package import path is ignored');
  assert(!hints.includes('.proto'), 'relative go_package dot-normalized path is ignored');
  assert(hints.includes('transport'), 'go_package alias is retained');
});

group('proto aliases — C# enum values', () => {
  const aliases = createProtoSearchAliases('COLOR_RED', 'csharp', 'value', { containerName: 'Color' });
  assert(aliases.includes('COLOR_RED'), 'keeps original enum value');
  assert(aliases.includes('RED'), 'strips enum prefix before further conversion');
  assert(aliases.includes('Red'), 'C# enum value is converted to PascalCase');
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
}

console.log(`\nAll tests passed (${passed}).`);
