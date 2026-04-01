import * as vscode from 'vscode';
import { symbolKindToIconId } from '../core/SymbolRanker';
import { parseStructuredText, isStructuredTextLanguage, StructuredNode, StructuredNodeKind } from '../core/StructuredTextParser';

// ── Doc comment extraction ───────────────────────────────────────────────────

export function extractDocComment(doc: vscode.TextDocument, symbolStartLine: number): string | undefined {
  // 1. Check inline trailing comment on the same line: `Name string // Worker 名称`
  const lineText = doc.lineAt(symbolStartLine).text;
  const inlineMatch = lineText.match(/\/\/\s?(.*)/);
  if (inlineMatch && !lineText.trimStart().startsWith('//')) {
    return inlineMatch[1].trim() || undefined;
  }

  // 2. Check doc comment above the symbol
  let line = symbolStartLine - 1;
  let firstComment = '';
  while (line >= 0) {
    const text = doc.lineAt(line).text.trimStart();
    if (text.startsWith('//')) {
      firstComment = text.replace(/^\/\/\s?/, '');
      line--;
    } else {
      break;
    }
  }
  return firstComment || undefined;
}

// ── Tree node ────────────────────────────────────────────────────────────────

class SymbolNode extends vscode.TreeItem {
  public readonly children: SymbolNode[];

  constructor(
    public readonly symbol: vscode.DocumentSymbol,
    documentUri: vscode.Uri,
    doc: vscode.TextDocument,
  ) {
    const isType = [
      vscode.SymbolKind.Interface, vscode.SymbolKind.Struct,
      vscode.SymbolKind.Class, vscode.SymbolKind.Enum,
    ].includes(symbol.kind);
    super(
      isType
        ? { label: symbol.name, highlights: [[0, symbol.name.length]] }
        : symbol.name,
      symbol.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    const sig = buildSignature(symbol);
    const comment = isStructuredTextLanguage(doc.languageId)
      ? undefined
      : extractDocComment(doc, symbol.range.start.line);
    this.description = comment ? `${sig}  // ${comment}` : sig;
    this.iconPath = new vscode.ThemeIcon(symbolKindToIconId(symbol.kind));
    this.tooltip = `${symbol.name}  ${sig}${comment ? '\n' + comment : ''}`;
    this.command = {
      command: 'smartReferences.previewReference',
      title: 'Go to Symbol',
      arguments: [documentUri, symbol.selectionRange],
    };
    this.children = symbol.children.map(c => new SymbolNode(c, documentUri, doc));
  }
}

function buildSignature(sym: vscode.DocumentSymbol): string {
  const detail = sym.detail;
  if (detail) return detail;

  switch (sym.kind) {
    case vscode.SymbolKind.Namespace: return 'section';
    case vscode.SymbolKind.Object:    return 'object';
    case vscode.SymbolKind.Array:     return 'array';
    case vscode.SymbolKind.Key:       return 'key';
    case vscode.SymbolKind.Module:    return 'heading';
    case vscode.SymbolKind.String:    return 'tag';
    case vscode.SymbolKind.Function:  return detail === 'target' ? 'target' : 'func';
    case vscode.SymbolKind.Interface: return 'interface{...}';
    case vscode.SymbolKind.Struct:    return 'struct{...}';
    case vscode.SymbolKind.Class:     return 'class';
    case vscode.SymbolKind.Enum:      return 'enum';
    case vscode.SymbolKind.Method:    return 'method';
    case vscode.SymbolKind.Variable:  return 'var';
    case vscode.SymbolKind.Constant:  return 'const';
    case vscode.SymbolKind.Field:     return 'field';
    case vscode.SymbolKind.Property:  return 'property';
    default: return '';
  }
}

// ── Group receiver methods under their type ──────────────────────────────────

const RECEIVER_RE = /^\(\*?(\w+)\)\.(.+)$/;

function groupMethodsUnderTypes(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const typeMap = new Map<string, vscode.DocumentSymbol>();
  const topLevel: vscode.DocumentSymbol[] = [];
  const orphanMethods: vscode.DocumentSymbol[] = [];

  // First pass: collect types
  for (const sym of symbols) {
    if ([vscode.SymbolKind.Struct, vscode.SymbolKind.Class, vscode.SymbolKind.Interface].includes(sym.kind)) {
      typeMap.set(sym.name, sym);
    }
  }

  // Second pass: route methods to their receiver type
  for (const sym of symbols) {
    const m = RECEIVER_RE.exec(sym.name);
    if (m) {
      const [, typeName, methodName] = m;
      const parent = typeMap.get(typeName);
      if (parent) {
        // Create a copy with shortened name
        const child = new vscode.DocumentSymbol(
          methodName, sym.detail, sym.kind,
          sym.range, sym.selectionRange,
        );
        child.children = sym.children;
        parent.children.push(child);
      } else {
        orphanMethods.push(sym);
      }
    } else {
      topLevel.push(sym);
    }
  }

  topLevel.push(...orphanMethods);
  return topLevel;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class StructureTreeProvider implements vscode.TreeDataProvider<SymbolNode>, vscode.Disposable {
  private _onDidChangeTreeData = new vscode.EventEmitter<SymbolNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private roots: SymbolNode[] = [];
  private nodeMap = new Map<string, SymbolNode>();
  private documentUri: vscode.Uri | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private treeView: vscode.TreeView<SymbolNode> | undefined;

  setTreeView(view: vscode.TreeView<SymbolNode>): void {
    this.treeView = view;
  }

  async setDocument(doc: vscode.TextDocument): Promise<void> {
    this.documentUri = doc.uri;
    await this.refresh();
  }

  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 500);
  }

  async refresh(): Promise<void> {
    if (!this.documentUri) {
      this.roots = [];
      this.nodeMap.clear();
      this._onDidChangeTreeData.fire();
      return;
    }

    try {
      const [symbols, doc] = await Promise.all([
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider',
          this.documentUri,
        ),
        vscode.workspace.openTextDocument(this.documentUri),
      ]);
      const list = Array.isArray(symbols) ? symbols : [];
      const fallback = list.length === 0 && isStructuredTextLanguage(doc.languageId)
        ? buildStructuredDocumentSymbols(doc)
        : [];
      const effectiveSymbols = list.length > 0 ? list : fallback;
      const grouped = groupMethodsUnderTypes(effectiveSymbols);
      this.roots = grouped.map(s => new SymbolNode(s, this.documentUri!, doc));
      this.nodeMap.clear();
      this.buildNodeMap(this.roots);
    } catch {
      this.roots = [];
      this.nodeMap.clear();
    }

    this._onDidChangeTreeData.fire();
  }

  revealAtPosition(position: vscode.Position): void {
    if (!this.treeView || this.roots.length === 0) return;
    const node = this.findNodeAt(this.roots, position);
    if (node) {
      this.treeView.reveal(node, { select: true, focus: false, expand: false });
    }
  }

  getTreeItem(element: SymbolNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SymbolNode): SymbolNode[] {
    if (!element) return this.roots;
    return element.children;
  }

  getParent(element: SymbolNode): SymbolNode | undefined {
    const parentKey = this.findParentKey(element);
    return parentKey ? this.nodeMap.get(parentKey) : undefined;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this._onDidChangeTreeData.dispose();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildNodeMap(nodes: SymbolNode[], parent?: SymbolNode): void {
    for (const node of nodes) {
      const key = nodeKey(node);
      this.nodeMap.set(key, node);
      if (parent) this.nodeMap.set(key + '\0parent', parent);
      if (node.children.length > 0) {
        this.buildNodeMap(node.children, node);
      }
    }
  }

  private findParentKey(element: SymbolNode): string | undefined {
    const parent = this.nodeMap.get(nodeKey(element) + '\0parent');
    return parent ? nodeKey(parent) : undefined;
  }

  private findNodeAt(nodes: SymbolNode[], position: vscode.Position): SymbolNode | undefined {
    for (const node of nodes) {
      if (node.symbol.range.contains(position)) {
        const child = this.findNodeAt(node.children, position);
        return child ?? node;
      }
    }
    return undefined;
  }
}

function nodeKey(node: SymbolNode): string {
  return `${node.symbol.name}:${node.symbol.range.start.line}`;
}

function buildStructuredDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
  const nodes = parseStructuredText(doc.languageId, doc.getText());
  return nodes.map(node => toDocumentSymbol(node));
}

function toDocumentSymbol(node: StructuredNode): vscode.DocumentSymbol {
  const children = node.children.map(child => toDocumentSymbol(child));
  const endLine = computeEndLine(node);
  const detail = node.detail ?? structuredKindLabel(node.kind);
  const symbol = new vscode.DocumentSymbol(
    node.name,
    detail,
    structuredKindToSymbolKind(node.kind, children.length > 0),
    new vscode.Range(node.line, 0, endLine, Number.MAX_SAFE_INTEGER),
    new vscode.Range(node.line, node.column, node.line, node.column + node.name.length),
  );
  symbol.children = children;
  return symbol;
}

function computeEndLine(node: StructuredNode): number {
  let endLine = node.line;
  for (const child of node.children) {
    endLine = Math.max(endLine, computeEndLine(child));
  }
  return endLine;
}

function structuredKindToSymbolKind(kind: StructuredNodeKind, hasChildren: boolean): vscode.SymbolKind {
  switch (kind) {
    case 'section':
      return hasChildren ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Key;
    case 'array':
      return vscode.SymbolKind.Array;
    case 'property':
      return vscode.SymbolKind.Property;
    case 'heading':
      return vscode.SymbolKind.Module;
    case 'tag':
      return vscode.SymbolKind.String;
    case 'target':
      return vscode.SymbolKind.Function;
  }
}

function structuredKindLabel(kind: StructuredNodeKind): string {
  switch (kind) {
    case 'section': return 'section';
    case 'array': return 'array';
    case 'property': return 'key';
    case 'heading': return 'heading';
    case 'tag': return 'tag';
    case 'target': return 'target';
  }
}
