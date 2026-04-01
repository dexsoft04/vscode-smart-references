import * as vscode from 'vscode';

export type WorkspaceLanguageId =
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'typescript'
  | 'python'
  | 'javascript'
  | 'csharp'
  | 'unknown';

export interface WorkspaceLanguageProfile {
  id: WorkspaceLanguageId;
  extensions: string[];
}

const MARKERS: Array<{ files: string[]; language: WorkspaceLanguageProfile }> = [
  { files: ['go.mod'], language: { id: 'go', extensions: ['.go'] } },
  { files: ['Cargo.toml'], language: { id: 'rust', extensions: ['.rs'] } },
  { files: ['pom.xml'], language: { id: 'java', extensions: ['.java'] } },
  { files: ['build.gradle.kts'], language: { id: 'kotlin', extensions: ['.kt', '.kts', '.java'] } },
  { files: ['build.gradle'], language: { id: 'kotlin', extensions: ['.kt', '.kts', '.java'] } },
  { files: ['tsconfig.json'], language: { id: 'typescript', extensions: ['.ts', '.tsx', '.vue'] } },
  { files: ['pyproject.toml', 'requirements.txt', 'setup.py'], language: { id: 'python', extensions: ['.py'] } },
  { files: ['package.json'], language: { id: 'javascript', extensions: ['.js', '.jsx'] } },
];

export async function detectMainWorkspaceLanguage(): Promise<WorkspaceLanguageProfile> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { id: 'unknown', extensions: [] };
  }

  for (const folder of folders) {
    for (const marker of MARKERS) {
      for (const file of marker.files) {
        try {
          await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, file));
          return marker.language;
        } catch {
          // marker not found
        }
      }
    }

    const csharpFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '*.{sln,csproj}'),
      undefined,
      1,
    );
    if (csharpFiles.length > 0) {
      return { id: 'csharp', extensions: ['.cs'] };
    }
  }

  return { id: 'unknown', extensions: [] };
}
