export type StructuredNodeKind =
  | 'section'
  | 'array'
  | 'property'
  | 'heading'
  | 'tag'
  | 'target';

export interface StructuredNode {
  name: string;
  kind: StructuredNodeKind;
  line: number;
  column: number;
  detail?: string;
  children: StructuredNode[];
}

const STRUCTURED_TEXT_LANGS = new Set([
  'toml',
  'yaml',
  'json',
  'jsonc',
  'ini',
  'properties',
  'markdown',
  'xml',
  'html',
  'makefile',
  'make',
]);

interface StackEntry {
  indent: number;
  node: StructuredNode;
}

export function isStructuredTextLanguage(languageId: string): boolean {
  return STRUCTURED_TEXT_LANGS.has(languageId);
}

export function parseStructuredText(languageId: string, text: string): StructuredNode[] {
  switch (languageId) {
    case 'toml':
      return parseToml(text);
    case 'yaml':
      return parseYaml(text);
    case 'json':
    case 'jsonc':
      return parseJsonLike(text);
    case 'ini':
    case 'properties':
      return parseIniLike(text);
    case 'markdown':
      return parseMarkdown(text);
    case 'xml':
    case 'html':
      return parseXmlLike(text);
    case 'makefile':
    case 'make':
      return parseMakefile(text);
    default:
      return [];
  }
}

function parseToml(text: string): StructuredNode[] {
  const roots: StructuredNode[] = [];
  let currentSection: StructuredNode | undefined;

  for (const [lineNo, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const arrayTableMatch = rawLine.match(/^\s*\[\[([^\]]+)\]\]\s*$/);
    if (arrayTableMatch) {
      currentSection = createTomlSection(roots, arrayTableMatch[1], lineNo, true);
      continue;
    }

    const tableMatch = rawLine.match(/^\s*\[([^\]]+)\]\s*$/);
    if (tableMatch) {
      currentSection = createTomlSection(roots, tableMatch[1], lineNo, false);
      continue;
    }

    const eqIndex = rawLine.indexOf('=');
    if (eqIndex <= 0) continue;

    const rawKey = rawLine.slice(0, eqIndex).trim();
    if (!rawKey) continue;
    const keySegments = rawKey.split('.').map(segment => segment.trim()).filter(Boolean);
    if (keySegments.length === 0) continue;

    const valuePreview = previewValue(rawLine.slice(eqIndex + 1));
    addPathNode(currentSection?.children ?? roots, keySegments, lineNo, rawLine.indexOf(rawKey), {
      leafKind: 'property',
      detail: valuePreview,
    });
  }

  return roots;
}

function createTomlSection(
  roots: StructuredNode[],
  rawPath: string,
  line: number,
  isArray: boolean,
): StructuredNode {
  const segments = rawPath.split('.').map(segment => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    return createNode(rawPath, isArray ? 'array' : 'section', line, 0, isArray ? 'table[]' : 'table');
  }

  const parentSegments = segments.slice(0, -1);
  const leafName = isArray ? `${segments[segments.length - 1]}[]` : segments[segments.length - 1];
  const parent = parentSegments.length > 0
    ? addPathNode(roots, parentSegments, line, 0, { leafKind: 'section', detail: 'table' })
    : undefined;

  const siblings = parent?.children ?? roots;
  const existing = !isArray
    ? siblings.find(node => node.name === leafName && node.kind === 'section')
    : undefined;
  if (existing) {
    existing.line = Math.min(existing.line, line);
    return existing;
  }

  const node = createNode(leafName, isArray ? 'array' : 'section', line, 0, isArray ? 'table[]' : 'table');
  siblings.push(node);
  return node;
}

function parseIniLike(text: string): StructuredNode[] {
  const roots: StructuredNode[] = [];
  let currentSection: StructuredNode | undefined;

  for (const [lineNo, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = rawLine.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = createNode(sectionMatch[1].trim(), 'section', lineNo, rawLine.indexOf('['), 'section');
      roots.push(currentSection);
      continue;
    }

    const separatorIndex = findIniSeparator(rawLine);
    if (separatorIndex <= 0) continue;

    const key = rawLine.slice(0, separatorIndex).trim();
    if (!key) continue;
    const value = previewValue(rawLine.slice(separatorIndex + 1));
    (currentSection?.children ?? roots).push(
      createNode(key, 'property', lineNo, rawLine.indexOf(key), value),
    );
  }

  return roots;
}

function parseYaml(text: string): StructuredNode[] {
  const roots: StructuredNode[] = [];
  const stack: StackEntry[] = [];

  for (const [lineNo, rawLine] of text.split('\n').entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const keyMatch = rawLine.match(/^(\s*)([^:#\-\s][^:#]*):(?:\s*(.*?)\s*)?$/);
    if (keyMatch) {
      popIndented(stack, indent);
      const key = keyMatch[2].trim();
      const inlineValue = previewValue(keyMatch[3] ?? '');
      const node = createNode(key, 'section', lineNo, indent, inlineValue);
      pushNode(roots, stack, node);
      if (!inlineValue) {
        stack.push({ indent, node });
      }
      continue;
    }

    const listMatch = rawLine.match(/^(\s*)-\s+(.*)$/);
    if (listMatch) {
      popIndented(stack, indent);
      const inline = listMatch[2].trim();
      const inlineMapMatch = inline.match(/^([^:#\[\{][^:#]*):(?:\s*(.*?)\s*)?$/);
      const label = inlineMapMatch
        ? '- item'
        : (inline.startsWith('{') || inline.startsWith('[') ? '-' : `- ${truncate(inline, 32)}`);
      const node = createNode(label, 'array', lineNo, indent, inlineMapMatch ? '' : previewValue(inline));
      pushNode(roots, stack, node);

      if (inlineMapMatch) {
        const childValue = previewValue(inlineMapMatch[2] ?? '');
        const child = createNode(
          inlineMapMatch[1].trim(),
          childValue ? 'property' : 'section',
          lineNo,
          indent + 2,
          childValue,
        );
        node.children.push(child);
        if (childValue) {
          stack.push({ indent, node });
        } else {
          stack.push({ indent, node });
          stack.push({ indent: indent + 2, node: child });
        }
      } else if (!inline || inline.endsWith(':')) {
        stack.push({ indent, node });
      }
    }
  }

  return roots;
}

function parseJsonLike(text: string): StructuredNode[] {
  const roots: StructuredNode[] = [];
  const stack: StackEntry[] = [];

  for (const [lineNo, rawLine] of text.split('\n').entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed === '{' || trimmed === '[') {
      continue;
    }
    if (trimmed.startsWith('}') || trimmed.startsWith(']')) {
      const indent = rawLine.length - rawLine.trimStart().length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const keyMatch = rawLine.match(/^(\s*)"([^"]+)"\s*:\s*(.*)$/);
    if (!keyMatch) continue;

    popIndented(stack, indent);
    const key = keyMatch[2];
    const remainder = keyMatch[3].replace(/,$/, '').trim();
    const detail = previewValue(remainder);
    const isContainer = remainder === '{' || remainder === '[' || remainder === '';
    const node = createNode(key, isContainer ? 'section' : 'property', lineNo, indent, detail);
    pushNode(roots, stack, node);
    if (isContainer) {
      stack.push({ indent, node });
    }
  }

  return roots;
}

function parseMarkdown(text: string): StructuredNode[] {
  const roots: StructuredNode[] = [];
  const stack: Array<{ level: number; node: StructuredNode }> = [];

  for (const [lineNo, rawLine] of text.split('\n').entries()) {
    const match = rawLine.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;

    const level = match[1].length;
    const heading = match[2].trim();
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const node = createNode(heading, 'heading', lineNo, 0, `h${level}`);
    if (stack.length > 0) {
      stack[stack.length - 1].node.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ level, node });
  }

  return roots;
}

function parseXmlLike(text: string): StructuredNode[] {
  const roots: StructuredNode[] = [];
  const stack: StructuredNode[] = [];
  const tagRe = /<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?(\/?)>/g;

  for (const [lineNo, rawLine] of text.split('\n').entries()) {
    if (!rawLine.includes('<')) continue;

    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRe.exec(rawLine)) !== null) {
      if (tagMatch[1]) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === tagMatch[1]) {
            stack.length = i;
            break;
          }
        }
      } else {
        const tag = tagMatch[2];
        if (!tag || tag.startsWith('!') || tag.startsWith('?')) continue;
        const isSelfClosing = tagMatch[3] === '/';
        const node = createNode(tag, 'tag', lineNo, tagMatch.index, 'tag');
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(node);
        } else {
          roots.push(node);
        }
        if (!isSelfClosing) {
          stack.push(node);
        }
      }
    }

    tagRe.lastIndex = 0;
  }

  return roots;
}

function parseMakefile(text: string): StructuredNode[] {
  const roots: StructuredNode[] = [];
  let currentTarget: StructuredNode | undefined;

  for (const [lineNo, rawLine] of text.split('\n').entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (/^\t/.test(rawLine) || /^ {2,}/.test(rawLine)) {
      if (currentTarget) {
        currentTarget.children.push(createNode(trimmed, 'property', lineNo, rawLine.search(/\S/), 'command'));
      }
      continue;
    }

    currentTarget = undefined;

    const variableMatch = rawLine.match(/^\s*(?:export\s+|override\s+)?([A-Za-z0-9_.-]+)\s*[:+?]?=\s*(.*)$/);
    if (variableMatch) {
      roots.push(createNode(
        variableMatch[1],
        'property',
        lineNo,
        rawLine.indexOf(variableMatch[1]),
        previewValue(variableMatch[2]),
      ));
      continue;
    }

    const targetMatch = rawLine.match(/^\s*([^:=#\s][^:=#]*?):(?![=])\s*(.*?)\s*$/);
    if (targetMatch) {
      currentTarget = createNode(
        targetMatch[1].trim(),
        'target',
        lineNo,
        rawLine.indexOf(targetMatch[1]),
        targetMatch[2] ? truncate(targetMatch[2].trim(), 40) : 'target',
      );
      roots.push(currentTarget);
    }
  }

  return roots;
}

function addPathNode(
  roots: StructuredNode[],
  segments: string[],
  line: number,
  column: number,
  options: { leafKind: StructuredNodeKind; detail?: string },
): StructuredNode {
  let siblings = roots;
  let current: StructuredNode | undefined;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLeaf = i === segments.length - 1;
    let node = siblings.find(existing => existing.name === segment && existing.kind === (isLeaf ? options.leafKind : 'section'));
    if (!node) {
      node = createNode(segment, isLeaf ? options.leafKind : 'section', line, column, isLeaf ? options.detail : 'section');
      siblings.push(node);
    }
    current = node;
    siblings = node.children;
  }

  return current!;
}

function pushNode(roots: StructuredNode[], stack: StackEntry[], node: StructuredNode): void {
  if (stack.length > 0) {
    stack[stack.length - 1].node.children.push(node);
  } else {
    roots.push(node);
  }
}

function popIndented(stack: StackEntry[], indent: number): void {
  while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
    stack.pop();
  }
}

function createNode(
  name: string,
  kind: StructuredNodeKind,
  line: number,
  column: number,
  detail?: string,
): StructuredNode {
  return {
    name,
    kind,
    line,
    column,
    detail,
    children: [],
  };
}

function findIniSeparator(line: string): number {
  const eqIndex = line.indexOf('=');
  const colonIndex = line.indexOf(':');
  if (eqIndex < 0) return colonIndex;
  if (colonIndex < 0) return eqIndex;
  return Math.min(eqIndex, colonIndex);
}

function previewValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withoutComment = trimmed
    .replace(/\s+#.*$/, '')
    .replace(/\s+\/\/.*$/, '')
    .replace(/,$/, '')
    .trim();
  return truncate(withoutComment, 40);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1) + '…';
}
