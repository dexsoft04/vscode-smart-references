import * as vscode from 'vscode';

export type SearchNode = SectionNode | WorkspaceNode | FileNode | MatchNode | ContextLineNode;
export type TextSearchContentKind = 'code' | 'comment';
export type TextSearchFileKind = 'code' | 'config' | 'other';
export type ExcludeConfigValue = boolean | { when?: string };
export type CommentSyntax = 'slash' | 'hash' | 'dashdash' | 'xml' | 'semicolon';

export type TextSearchGroupingMode = 'none' | 'content' | 'fileKind' | 'both';

export interface TextSearchRequest {
  readonly query: string;
  readonly replaceText: string;
  readonly include: string;
  readonly exclude: string;
  readonly useRegExp: boolean;
  readonly matchCase: boolean;
  readonly matchWholeWord: boolean;
  readonly fuzzySearch: boolean;
  readonly beforeContextLines: number;
  readonly afterContextLines: number;
}


export interface TextSearchLineState {
  readonly lineNumber: number;
  readonly text: string;
}

export interface TextSearchMatchState {
  readonly key: string;
  readonly uri: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly matchedText: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
  readonly beforeLines: TextSearchLineState[];
  readonly afterLines: TextSearchLineState[];
  readonly contentKind: TextSearchContentKind;
}

export interface TextSearchFileState {
  readonly key: string;
  readonly workspaceName: string;
  readonly uri: string;
  readonly relativePath: string;
  readonly matchCount: number;
  readonly fileKind: TextSearchFileKind;
  readonly matches: TextSearchMatchState[];
}

export interface TextSearchSectionState {
  readonly key: string;
  readonly label: string;
  readonly matchCount: number;
  readonly fileCount: number;
  readonly files: TextSearchFileState[];
}

export interface TextSearchViewState {
  readonly title: string;
  readonly request?: TextSearchRequest;
  readonly warning?: string;
  readonly groupingMode: TextSearchGroupingMode;
  readonly totalMatches: number;
  readonly totalFiles: number;
  readonly sections: TextSearchSectionState[];
}

export interface TextSearchReplaceTarget {
  readonly key: string;
  readonly uri: string;
  readonly sectionKey: string;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly matchedText: string;
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

export interface TextSearchContextLine {
  readonly lineNumber: number;
  readonly text: string;
}

export interface TextSearchExcludeRule {
  readonly pattern: string;
  readonly regex: RegExp;
  readonly when?: string;
}

export interface TextSearchMatch {
  readonly workspaceName: string;
  readonly workspaceUri: vscode.Uri;
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly range: vscode.Range;
  readonly beforeLines: TextSearchContextLine[];
  readonly afterLines: TextSearchContextLine[];
  readonly contentKind: TextSearchContentKind;
  readonly fileKind: TextSearchFileKind;
}

export interface TextSearchOptions {
  readonly beforeContextLines: number;
  readonly afterContextLines: number;
  readonly includeGlobs: string[];
  readonly excludeGlobs: string[];
  readonly excludeRules: TextSearchExcludeRule[];
  readonly fuzzySearch: boolean;
  readonly useRegExp: boolean;
  readonly matchCase: boolean;
  readonly matchWholeWord: boolean;
  readonly smartCase: boolean;
  readonly groupCodeAndComments: boolean;
  readonly groupConfigAndCodeFiles: boolean;
  readonly useIgnoreFiles: boolean;
  readonly useGlobalIgnoreFiles: boolean;
  readonly useParentIgnoreFiles: boolean;
  readonly followSymlinks: boolean;
  readonly maxFuzzyFileScan: number;
  readonly maxFuzzyMatches: number;
}

export interface RawSearchMatch {
  readonly workspaceName: string;
  readonly workspaceUri: vscode.Uri;
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineText: string;
  readonly range: vscode.Range;
}

export interface WorkspaceBucket {
  readonly folder: vscode.WorkspaceFolder;
  readonly matches: TextSearchMatch[];
}

export interface SectionBucket {
  readonly key: string;
  readonly label: string;
  readonly matches: TextSearchMatch[];
}

export interface FileBucket {
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly matches: TextSearchMatch[];
}

export interface RgSubmatch {
  start?: number;
  end?: number;
}

export interface RgJsonMessage {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: RgSubmatch[];
  };
}

export interface CommentRangesForLine {
  readonly ranges: Array<{ start: number; end: number }>;
  readonly nextInBlockComment: boolean;
}

export const CONFIG_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'cargo.toml', 'cargo.lock', 'pyproject.toml', 'requirements.txt', 'pipfile', 'pipfile.lock',
  'poetry.lock', 'setup.py', 'setup.cfg', 'go.mod', 'go.sum', 'makefile', 'cmakelists.txt',
  '.editorconfig', '.gitignore', '.gitattributes', '.npmrc', '.yarnrc', '.yarnrc.yml', '.prettierrc',
  '.prettierrc.json', '.prettierrc.yaml', '.eslintrc', '.eslintrc.json', '.eslintrc.yaml',
  'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.env', '.env.local', '.env.test',
  '.env.production', 'pubspec.yaml', 'pubspec.lock', 'gradle.properties', 'settings.gradle',
]);

export const CONFIG_EXTENSIONS = new Set([
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.properties', '.env', '.conf', '.config',
  '.xml', '.editorconfig', '.gitignore', '.gitattributes', '.lock',
]);

export const OTHER_TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst', '.adoc', '.asciidoc',
]);

export const OTHER_TEXT_LANGUAGE_IDS = new Set([
  'markdown', 'plaintext',
]);

// Forward declarations for circular reference avoidance - these classes are defined in nodes.ts
// but declared here for the SearchNode type alias
import type { SectionNode } from './nodes';
import type { WorkspaceNode } from './nodes';
import type { FileNode } from './nodes';
import type { MatchNode } from './nodes';
import type { ContextLineNode } from './nodes';
