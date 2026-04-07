import * as vscode from 'vscode';
import { SectionBucket, WorkspaceBucket, FileBucket, TextSearchMatch, TextSearchContextLine } from './types';
import { clamp } from './utils';
import { t } from '../../i18n';

export class SectionNode extends vscode.TreeItem {
  constructor(public readonly bucket: SectionBucket) {
    super(bucket.label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${bucket.matches.length}`;
    this.iconPath = new vscode.ThemeIcon('folder-library');
    this.contextValue = 'textSearchSection';
  }
}

export class WorkspaceNode extends vscode.TreeItem {
  constructor(public readonly bucket: WorkspaceBucket) {
    super(bucket.folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.description = `${bucket.matches.length}`;
    this.tooltip = bucket.folder.uri.fsPath;
    this.iconPath = new vscode.ThemeIcon('root-folder');
    this.contextValue = 'textSearchWorkspace';
  }
}

export class FileNode extends vscode.TreeItem {
  constructor(public readonly bucket: FileBucket) {
    super(bucket.relativePath, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${bucket.matches.length}`;
    this.tooltip = bucket.uri.fsPath;
    this.resourceUri = bucket.uri;
    this.iconPath = new vscode.ThemeIcon('file-code');
    this.contextValue = 'textSearchFile';
  }
}

export class MatchNode extends vscode.TreeItem {
  constructor(public readonly match: TextSearchMatch) {
    super(buildMatchTreeItemLabel(match), buildContextCollapsibleState(match));
    this.description = `${match.lineNumber}`;
    this.tooltip = buildMatchTooltip(match);
    this.resourceUri = match.uri;
    this.iconPath = new vscode.ThemeIcon(match.contentKind === 'comment' ? 'comment' : 'search');
    this.command = {
      command: 'smartReferences.previewReference',
      title: t('预览搜索命中', 'Preview Search Match'),
      arguments: [match.uri, match.range],
    };
    this.contextValue = 'textSearchMatch';
  }
}

export class ContextLineNode extends vscode.TreeItem {
  constructor(public readonly match: TextSearchMatch, public readonly line: TextSearchContextLine, role: 'before' | 'current' | 'after') {
    super(role === 'current' ? buildMatchTreeItemLabel(match) : { label: line.text || t('(空行)', '(blank line)') }, vscode.TreeItemCollapsibleState.None);
    this.description = `${line.lineNumber}`;
    this.resourceUri = match.uri;
    this.iconPath = new vscode.ThemeIcon(
      role === 'before' ? 'arrow-up' : role === 'after' ? 'arrow-down' : 'search',
    );
    this.command = {
      command: 'smartReferences.previewReference',
      title: role === 'current' ? t('预览搜索命中', 'Preview Search Match') : t('预览搜索上下文', 'Preview Search Context'),
      arguments: [
        match.uri,
        role === 'current'
          ? match.range
          : new vscode.Range(line.lineNumber - 1, 0, line.lineNumber - 1, Math.max(line.text.length, 1)),
      ],
    };
    this.contextValue = role === 'current' ? 'textSearchContextCurrent' : 'textSearchContext';
  }
}

function buildMatchTreeItemLabel(match: TextSearchMatch): vscode.TreeItemLabel {
  const label = match.lineText || t('(空行)', '(blank line)');
  const start = clamp(match.range.start.character, 0, label.length);
  const end = clamp(match.range.end.character, start, label.length);
  return {
    label,
    highlights: start === end ? undefined : [[start, end]],
  };
}

function buildContextCollapsibleState(match: TextSearchMatch): vscode.TreeItemCollapsibleState {
  return match.beforeLines.length > 0 || match.afterLines.length > 0
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;
}

function buildMatchTooltip(match: TextSearchMatch): vscode.MarkdownString {
  const snippet = [
    ...match.beforeLines.map(line => `${String(line.lineNumber).padStart(5)}   ${line.text}`),
    `${String(match.lineNumber).padStart(5)} → ${match.lineText}`,
    ...match.afterLines.map(line => `${String(line.lineNumber).padStart(5)}   ${line.text}`),
  ].join('\n');
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${match.relativePath}:${match.lineNumber}**\n\n`);
  md.appendCodeblock(snippet || `${match.lineNumber}`, 'plaintext');
  return md;
}
