export type ProjectViewMode = 'merged' | 'categorized' | 'cpp-project' | 'hotspot';

export type CppProjectCategoryId =
  | 'cppModules'
  | 'cppIncludes'
  | 'cppTests'
  | 'cppBuild'
  | 'cppThirdParty';

const CPP_SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cp', '.cpp', '.cxx', '.c++', '.m', '.mm', '.swift', '.kt', '.rs', '.cs', '.java', '.ixx', '.cppm', '.tpp', '.ipp',
]);

const CPP_HEADER_EXTENSIONS = new Set([
  '.h', '.hh', '.hpp', '.hxx', '.h++', '.inl', '.inc', '.tcc',
]);

const BUILD_EXTENSIONS = new Set(['.mk', '.mak', '.cmake', '.sln', '.vcxproj', '.vcproj', '.filters', '.props', '.targets', '.pbxproj', '.csproj']);
const GENERATED_EXTENSIONS = new Set(['.pb.h', '.pb.cc', '.pb.cpp', '.pb.c', '.pb.hxx', '.pb.hpp', '.g.h', '.g.hpp', '.g.cpp']);
const BUILD_FILE_NAMES = new Set([
  'makefile', 'gnumakefile', 'cmakelists.txt', 'meson.build', 'meson_options.txt', 'build.ninja',
  'compile_commands.json', 'conanfile.txt', 'conanfile.py', 'vcpkg.json', 'configure.ac', 'configure.in',
  'autogen.sh', 'package.swift', 'cargo.toml', 'cargo.lock', 'build.gradle', 'build.gradle.kts', 'pom.xml',
  'settings.gradle', 'settings.gradle.kts', 'podfile', 'podfile.lock', 'cartfile', 'cartfile.resolved',
  'gradlew', 'gradlew.bat', 'project.pbxproj', 'directory.build.props', 'directory.build.targets',
  'nuget.config', 'packages.lock.json', 'global.json',
]);
const THIRD_PARTY_SEGMENTS = new Set([
  'third_party', 'third-party', '3rdparty', 'vendor', 'vendors', 'external', 'extern', 'deps', 'dep',
  'dependencies', 'submodules', 'pods', 'carthage', '.build',
]);
const GENERATED_SEGMENTS = new Set([
  'generated', 'gen', 'gen_src', 'autogen',
]);
const TEST_SEGMENTS = new Set(['test', 'tests', 'testing', 'spec', 'specs', 'bench', 'benches', 'benchmark', 'benchmarks', 'unittest', 'unittests']);
const INCLUDE_SEGMENTS = new Set(['include', 'includes', 'inc', 'public']);

export const PROJECT_LAYOUT_RULES = {
  sourceExtensions: [...CPP_SOURCE_EXTENSIONS],
  headerExtensions: [...CPP_HEADER_EXTENSIONS],
  buildExtensions: [...BUILD_EXTENSIONS],
  generatedExtensions: [...GENERATED_EXTENSIONS],
  buildFileNames: [...BUILD_FILE_NAMES],
  thirdPartySegments: [...THIRD_PARTY_SEGMENTS],
  generatedSegments: [...GENERATED_SEGMENTS],
  testSegments: [...TEST_SEGMENTS],
  includeSegments: [...INCLUDE_SEGMENTS],
} as const;

export const CPP_PROJECT_CATEGORY_IDS: ReadonlyArray<CppProjectCategoryId> = [
  'cppTests',
  'cppModules',
  'cppIncludes',
  'cppBuild',
  'cppThirdParty',
];

export function isCppProjectCategory(category: string): category is CppProjectCategoryId {
  return CPP_PROJECT_CATEGORY_IDS.some(item => item === category);
}

export function getAvailableProjectViewModes(isCppProject: boolean): ProjectViewMode[] {
  const modes: ProjectViewMode[] = ['merged', 'categorized', 'hotspot'];
  if (isCppProject) modes.push('cpp-project');
  return modes;
}

export function resolveProjectViewMode(mode: ProjectViewMode, isCppProject: boolean): ProjectViewMode {
  return getAvailableProjectViewModes(isCppProject).includes(mode) ? mode : 'merged';
}

export function looksLikeCppProject(files: string[]): boolean {
  let sourceCount = 0;
  let headerCount = 0;

  for (const file of files) {
    if (isCppBuildFile(file)) return true;
    if (isCppSourceFile(file)) sourceCount += 1;
    if (isCppHeaderFile(file)) headerCount += 1;
    if (sourceCount >= 3 && headerCount >= 1) return true;
  }

  return sourceCount >= 5;
}

export function classifyCppProjectPath(relativePath: string, isTestFile: boolean): CppProjectCategoryId {
  const normalized = normalizePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const baseName = segments[segments.length - 1] ?? normalized;
  const plainExtension = getExtension(baseName);

  if (hasAnySegment(segments, THIRD_PARTY_SEGMENTS)) return 'cppThirdParty';
  if (isCppBuildFile(normalized, baseName, plainExtension, segments)) return 'cppBuild';
  if (isTestFile || isTestPath(baseName, segments)) return 'cppTests';
  if (isCppHeaderFile(baseName) || hasAnySegment(segments, INCLUDE_SEGMENTS)) return 'cppIncludes';
  return 'cppModules';
}

export function isGeneratedProjectPath(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const baseName = segments[segments.length - 1] ?? normalized;
  const compoundExtension = getCompoundExtension(baseName);
  return isGeneratedFile(baseName, compoundExtension, segments);
}

export function shouldDimMergedTestFile(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  const segments = normalized.split('/').filter(Boolean);
  const dirSegments = segments.slice(0, -1);
  return !hasAnySegment(dirSegments, TEST_SEGMENTS);
}

export function detectProjectRoots(files: string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const root = getProjectRootFromBuildFile(file);
    if (root !== undefined) roots.add(root);
  }
  if (roots.size === 0 && looksLikeCppProject(files)) return [''];
  return [...roots].sort((a, b) => a.localeCompare(b));
}

export function resolveProjectRoot(relativePath: string, projectRoots: readonly string[]): string {
  const normalized = normalizePath(relativePath);
  let bestRoot = '';
  let bestLength = 0;
  for (const candidate of projectRoots) {
    const normalizedCandidate = normalizePath(candidate);
    if (!normalizedCandidate) continue;
    if (normalized === normalizedCandidate || normalized.startsWith(`${normalizedCandidate}/`)) {
      if (normalizedCandidate.length > bestLength) {
        bestLength = normalizedCandidate.length;
        bestRoot = candidate;
      }
    }
  }
  return bestRoot;
}

function normalizePath(relativePath: string): string {
  return relativePath
    .replace(/[\\/]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function getExtension(baseName: string): string {
  const index = baseName.lastIndexOf('.');
  return index >= 0 ? baseName.slice(index) : '';
}

function getCompoundExtension(baseName: string): string {
  const lower = baseName.toLowerCase();
  for (const ext of GENERATED_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return getExtension(lower);
}

function hasAnySegment(segments: string[], expected: Set<string>): boolean {
  return segments.some(segment => expected.has(segment));
}

function isCppSourceFile(pathOrBaseName: string): boolean {
  return CPP_SOURCE_EXTENSIONS.has(getExtension(pathOrBaseName.toLowerCase()));
}

function isCppHeaderFile(pathOrBaseName: string): boolean {
  return CPP_HEADER_EXTENSIONS.has(getExtension(pathOrBaseName.toLowerCase()));
}

function isCppBuildFile(
  relativePath: string,
  maybeBaseName?: string,
  plainExtension?: string,
  segments?: string[],
): boolean {
  const normalized = normalizePath(relativePath);
  const baseName = maybeBaseName ?? normalized.split('/').pop() ?? normalized;
  const simpleExtension = plainExtension ?? getExtension(baseName);
  const pathSegments = segments ?? normalized.split('/').filter(Boolean);
  if (BUILD_FILE_NAMES.has(baseName)) return true;
  if (BUILD_EXTENSIONS.has(simpleExtension)) return true;
  return pathSegments.some(segment => segment.endsWith('.xcodeproj') || segment.endsWith('.xcworkspace'));
}

function getProjectRootFromBuildFile(relativePath: string): string | undefined {
  const cleaned = relativePath
    .replace(/[\/]+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length === 0) return undefined;

  const normalizedSegments = segments.map(segment => segment.toLowerCase());
  const xcodeIndex = normalizedSegments.findIndex(segment => segment.endsWith('.xcodeproj') || segment.endsWith('.xcworkspace'));
  if (xcodeIndex >= 0) return segments.slice(0, xcodeIndex).join('/');

  const baseName = normalizedSegments[normalizedSegments.length - 1];
  const parentDir = segments.length === 1 ? '' : segments.slice(0, -1).join('/');
  if (BUILD_FILE_NAMES.has(baseName)) return parentDir;
  if (BUILD_EXTENSIONS.has(getExtension(baseName))) return parentDir;
  return undefined;
}

function isGeneratedFile(baseName: string, compoundExtension: string, segments: string[]): boolean {
  if (compoundExtension && GENERATED_EXTENSIONS.has(compoundExtension)) return true;
  if (baseName.endsWith('_generated.h') || baseName.endsWith('_generated.hpp') || baseName.endsWith('_generated.cpp')) return true;
  return hasAnySegment(segments, GENERATED_SEGMENTS);
}

function isTestPath(baseName: string, segments: string[]): boolean {
  if (hasAnySegment(segments, TEST_SEGMENTS)) return true;
  return /(^test[_-])|([_-](test|tests|spec|specs|benchmark|bench)$)|((test|spec)\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$)/.test(baseName);
}
