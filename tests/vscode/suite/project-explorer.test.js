const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

async function waitFor(getValue, label, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await getValue();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function getApi() {
  const extension = vscode.extensions.getExtension('smart-references.vscode-intellij-style-references');
  assert(extension, 'extension should be registered');
  return extension.activate();
}

async function run() {
  const api = await getApi();
  assert(api, 'extension should expose an API for integration tests');

  await api.refreshProjectExplorer(true);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert(workspaceRoot, 'workspace root should be available');
  const expectCppProject = fs.existsSync(path.join(workspaceRoot, 'CMakeLists.txt'));
  const initialState = await waitFor(async () => {
    const state = api.getProjectExplorerState();
    if (state.availableViewModes.length >= 2) return state;
    return undefined;
  }, 'project explorer state');

  if (expectCppProject) {
    assert(initialState.availableViewModes.includes('cpp-project'), 'cpp project workspace should expose project layout mode');
    await api.setProjectExplorerViewMode('cpp-project');
    const cppState = await waitFor(async () => {
      const state = api.getProjectExplorerState();
      return state.currentViewMode === 'cpp-project' ? state : undefined;
    }, 'cpp project layout mode');
    assert.deepStrictEqual(cppState.availableViewModes, ['merged', 'categorized', 'cpp-project'], 'cpp project workspace should keep all 3 modes');
  } else {
    assert(!initialState.availableViewModes.includes('cpp-project'), 'plain workspace should not expose project layout mode');
    await api.setProjectExplorerViewMode('cpp-project');
    const plainState = await waitFor(async () => {
      const state = api.getProjectExplorerState();
      return state.currentViewMode === 'merged' ? state : undefined;
    }, 'plain fallback mode');
    assert.strictEqual(plainState.currentViewMode, 'merged', 'plain workspace should fall back to merged mode');
  }

  await vscode.commands.executeCommand('smartReferences.refreshProjectExplorer');
  const refreshedState = api.getProjectExplorerState();
  if (expectCppProject) {
    assert.strictEqual(refreshedState.currentViewMode, 'cpp-project', 'refresh command should preserve selected cpp project mode');
  } else {
    assert.strictEqual(refreshedState.currentViewMode, 'merged', 'refresh command should preserve merged fallback mode');
  }

  const markerPath = path.join(__dirname, '..', '.project-explorer-suite-ran.json');
  fs.writeFileSync(markerPath, JSON.stringify({
    expectCppProject,
    state: refreshedState,
  }));
}

module.exports = { run };
