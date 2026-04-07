export {
  SearchNode, TextSearchGroupingMode, TextSearchRequest, TextSearchReplaceTarget,
  TextSearchViewState, TextSearchMatchState, TextSearchFileState, TextSearchSectionState,
  TextSearchLineState, TextSearchContentKind, TextSearchFileKind, TextSearchMatch,
  TextSearchOptions, TextSearchContextLine, TextSearchExcludeRule, RawSearchMatch,
  WorkspaceBucket, SectionBucket, FileBucket, ExcludeConfigValue, CommentSyntax,
  RgSubmatch, RgJsonMessage, CommentRangesForLine,
  CONFIG_BASENAMES, CONFIG_EXTENSIONS, OTHER_TEXT_EXTENSIONS, OTHER_TEXT_LANGUAGE_IDS,
} from './types';

export { SectionNode, WorkspaceNode, FileNode, MatchNode, ContextLineNode } from './nodes';

export {
  clamp, splitGlobList, normalizeGlobs, dedupeStrings, shortenTitlePart,
  summarizeGlobInput, buildTextSearchTitle, readConfiguredContextLineCounts,
  createDefaultSearchRequest, globToRegex, normalizeRelativePath,
  collectExcludeRules, resolveWhenTarget, fileExists, shouldExcludeRelativePath,
  splitWorkspaceAndRelative, resolveCaseSensitive,
} from './utils';

export {
  applyRgSearchFlags, applySearchModeFlags, rgSourceLabel,
  runRgCommand, parseRgOutput, executeFixedRgSearch,
} from './ripgrepRunner';

export {
  findSubsequenceRange, utf8ByteOffsetToUtf16Column, findMatchRange,
  filterExcludedPaths, executeFuzzySearch,
} from './fuzzySearch';

export {
  getCommentSyntax, analyzeCommentRanges, buildCommentRangesByLine, detectContentKind,
} from './commentDetection';

export {
  detectFileKind, buildContext, buildSectionLabel, getSectionSortOrder, enrichMatches,
} from './matchEnrichment';

export {
  groupMatchesByWorkspace, groupMatchesByFile, buildSectionBuckets,
  buildSerializedSections, buildReplaceTarget,
} from './searchGrouping';

export { loadTextSearchOptions, TextSearchTreeProvider } from './TextSearchTreeProvider';
