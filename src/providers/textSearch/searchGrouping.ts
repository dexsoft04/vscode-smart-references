import * as vscode from 'vscode';
import {
  TextSearchMatch, TextSearchOptions, TextSearchLineState, TextSearchMatchState,
  TextSearchFileState, TextSearchSectionState, TextSearchReplaceTarget,
  WorkspaceBucket, SectionBucket, FileBucket,
} from './types';
import { buildSectionLabel, getSectionSortOrder } from './matchEnrichment';

export function groupMatchesByWorkspace(matches: TextSearchMatch[]): WorkspaceBucket[] {
  const buckets = new Map<string, WorkspaceBucket>();
  for (const match of matches) {
    const key = match.workspaceUri.toString();
    const folder = vscode.workspace.getWorkspaceFolder(match.workspaceUri) ?? {
      uri: match.workspaceUri,
      name: match.workspaceName,
      index: 0,
    };
    const bucket = buckets.get(key) ?? { folder, matches: [] };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.folder.name.localeCompare(b.folder.name));
}

export function groupMatchesByFile(matches: TextSearchMatch[]): FileBucket[] {
  const buckets = new Map<string, FileBucket>();
  for (const match of matches) {
    const key = match.uri.toString();
    const bucket = buckets.get(key) ?? {
      uri: match.uri,
      relativePath: match.relativePath,
      matches: [],
    };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => {
    const diff = b.matches.length - a.matches.length;
    if (diff !== 0) return diff;
    return a.relativePath.localeCompare(b.relativePath);
  });
}

function serializeLine(line: { lineNumber: number; text: string }): TextSearchLineState {
  return {
    lineNumber: line.lineNumber,
    text: line.text,
  };
}

function buildMatchKey(match: TextSearchMatch): string {
  return `${match.uri.toString()}#${match.range.start.line}:${match.range.start.character}-${match.range.end.line}:${match.range.end.character}`;
}

function extractMatchedText(match: TextSearchMatch): string {
  if (match.range.start.line !== match.range.end.line) return '';
  return match.lineText.slice(match.range.start.character, match.range.end.character);
}

function serializeMatch(match: TextSearchMatch): TextSearchMatchState {
  return {
    key: buildMatchKey(match),
    uri: match.uri.toString(),
    lineNumber: match.lineNumber,
    lineText: match.lineText,
    matchedText: extractMatchedText(match),
    startLine: match.range.start.line,
    startCharacter: match.range.start.character,
    endLine: match.range.end.line,
    endCharacter: match.range.end.character,
    beforeLines: match.beforeLines.map(serializeLine),
    afterLines: match.afterLines.map(serializeLine),
    contentKind: match.contentKind,
  };
}

function serializeFileBucket(bucket: FileBucket): TextSearchFileState {
  return {
    key: bucket.uri.toString(),
    workspaceName: bucket.matches[0]?.workspaceName ?? '',
    uri: bucket.uri.toString(),
    relativePath: bucket.relativePath,
    matchCount: bucket.matches.length,
    fileKind: bucket.matches[0]?.fileKind ?? 'code',
    matches: bucket.matches
      .slice()
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map(serializeMatch),
  };
}

export function buildSectionBuckets(matches: TextSearchMatch[], options: TextSearchOptions): SectionBucket[] {
  if (!options.groupCodeAndComments && !options.groupConfigAndCodeFiles) return [];
  const buckets = new Map<string, SectionBucket>();
  for (const match of matches) {
    const key = buildSectionLabel(match, options);
    const bucket = buckets.get(key) ?? { key, label: key, matches: [] };
    bucket.matches.push(match);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => {
    const order = getSectionSortOrder(a.label) - getSectionSortOrder(b.label);
    if (order !== 0) return order;
    return a.label.localeCompare(b.label);
  });
}

export function buildSerializedSections(matches: TextSearchMatch[], options: TextSearchOptions): TextSearchSectionState[] {
  const sectionBuckets = buildSectionBuckets(matches, options);
  if (sectionBuckets.length > 0) {
    return sectionBuckets.map(bucket => {
      const files = groupMatchesByFile(bucket.matches).map(serializeFileBucket);
      return {
        key: bucket.key,
        label: bucket.label,
        matchCount: bucket.matches.length,
        fileCount: files.length,
        files,
      };
    });
  }

  const workspaces = groupMatchesByWorkspace(matches);
  if (workspaces.length <= 1) {
    const files = workspaces.length === 1
      ? groupMatchesByFile(workspaces[0].matches).map(serializeFileBucket)
      : groupMatchesByFile(matches).map(serializeFileBucket);
    return [{
      key: 'all',
      label: '',
      matchCount: matches.length,
      fileCount: files.length,
      files,
    }];
  }

  return workspaces.map(bucket => {
    const files = groupMatchesByFile(bucket.matches).map(serializeFileBucket);
    return {
      key: bucket.folder.uri.toString(),
      label: bucket.folder.name,
      matchCount: bucket.matches.length,
      fileCount: files.length,
      files,
    };
  });
}

export function buildReplaceTarget(match: TextSearchMatch): TextSearchReplaceTarget {
  return {
    key: buildMatchKey(match),
    uri: match.uri.toString(),
    sectionKey: '',
    relativePath: match.relativePath,
    lineNumber: match.lineNumber,
    matchedText: extractMatchedText(match),
    startLine: match.range.start.line,
    startCharacter: match.range.start.character,
    endLine: match.range.end.line,
    endCharacter: match.range.end.character,
  };
}
