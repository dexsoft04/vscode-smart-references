const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { runTests } = require('@vscode/test-electron');

function isWindowsExecutable(executablePath) {
  return typeof executablePath === 'string' && executablePath.toLowerCase().endsWith('.exe');
}

function isCursorExecutable(executablePath) {
  if (typeof executablePath !== 'string' || !executablePath) return false;
  const normalized = executablePath.replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('/cursor.exe') || normalized.endsWith('/cursor');
}

function convertPathForExecutable(targetPath, executablePath) {
  if (!isWindowsExecutable(executablePath)) return targetPath;
  return execFileSync('wslpath', ['-m', targetPath], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function getTempRootForExecutable(executablePath) {
  if (!isWindowsExecutable(executablePath)) return os.tmpdir();

  const match = executablePath.match(/^\/mnt\/([a-z])\/Users\/([^/]+)\/AppData\/Local\//i);
  if (!match) return os.tmpdir();

  const tempRoot = path.join(`/mnt/${match[1].toLowerCase()}`, 'Users', match[2], 'AppData', 'Local', 'Temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  return tempRoot;
}

function discoverWindowsVsCodeExecutables() {
  const mountRoots = ['/mnt/c', '/mnt/d', '/mnt/e'];
  const executables = [];

  for (const mountRoot of mountRoots) {
    const usersDir = path.join(mountRoot, 'Users');
    if (!fs.existsSync(usersDir)) continue;

    for (const userName of fs.readdirSync(usersDir)) {
      executables.push(path.join(usersDir, userName, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'));
    }
  }

  return executables;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `"'"'`)}'`;
}

function getGitExecutableForPath(targetPath) {
  const windowsGit = '/mnt/c/Program Files/Git/cmd/git.exe';
  if (/^\/mnt\/[a-z]\//i.test(targetPath) && fs.existsSync(windowsGit)) {
    return windowsGit;
  }
  return 'git';
}

function runGit(args, cwd) {
  const gitExecutable = getGitExecutableForPath(cwd);
  if (isWindowsExecutable(gitExecutable)) {
    const command = [gitExecutable, ...args].map(shellQuote).join(' ');
    execFileSync('/bin/sh', ['-lc', command], { cwd, stdio: 'pipe' });
    return;
  }

  execFileSync(gitExecutable, args, { cwd, stdio: 'pipe' });
}

function resolveVsCodeExecutablePath() {
  const explicitCandidates = [
    process.env.SMART_REFERENCES_VSCODE_EXECUTABLE,
    process.env.VSCODE_EXECUTABLE,
  ].filter(Boolean);

  for (const candidate of explicitCandidates) {
    if (isCursorExecutable(candidate)) {
      throw new Error(`Cursor is not supported as the test host: ${candidate}`);
    }
  }

  const candidates = [
    ...explicitCandidates,
    ...discoverWindowsVsCodeExecutables(),
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function killProcessIds(processIds, executablePath) {
  if (!Array.isArray(processIds) || processIds.length === 0) return;

  const uniqueIds = [...new Set(processIds.map(value => String(value).trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return;

  if (isWindowsExecutable(executablePath)) {
    for (const pid of uniqueIds) {
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], { stdio: 'pipe' });
      } catch {
        // Ignore already-exited processes.
      }
    }
    return;
  }

  for (const pid of uniqueIds) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // Ignore already-exited processes.
    }
  }
}

function findTrackedProcessIds(matchers, executablePath) {
  const needles = matchers.map(value => String(value || '').trim()).filter(Boolean);
  if (needles.length === 0) return [];

  if (isWindowsExecutable(executablePath)) {
    const psNeedles = needles.map(value => value.replace(/'/g, "''"));
    const script = [
      '$needles = @(' + psNeedles.map(value => `'${value}'`).join(', ') + ')',
      '$processes = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine }',
      '$processes | Where-Object {',
      '  $cmd = $_.CommandLine',
      '  foreach ($needle in $needles) { if ($cmd -like ("*" + $needle + "*")) { return $true } }',
      '  return $false',
      '} | Select-Object -ExpandProperty ProcessId',
    ].join(' ');

    try {
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'pipe', encoding: 'utf8' });
      return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  try {
    const command = `ps -eo pid=,args= | grep -E ${shellQuote(needles.map(escapeRegExp).join('|'))} | grep -v grep`;
    const output = execFileSync('/bin/sh', ['-lc', command], { stdio: 'pipe', encoding: 'utf8' });
    return output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.split(/\s+/, 1)[0]);
  } catch {
    return [];
  }
}

function cleanupTrackedProcesses(matchers, executablePath) {
  const processIds = findTrackedProcessIds(matchers, executablePath);
  killProcessIds(processIds, executablePath);
}

function writeUserSettings(userDataDir, executablePath) {
  if (!isWindowsExecutable(executablePath)) return;

  const settingsDir = path.join(userDataDir, 'User');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ security: { allowedUNCHosts: ['wsl.localhost'] } }, null, 2),
  );
}

function writeWorkspaceFiles(rootDir, files) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, contents);
  }
}

function initGitRepo(rootDir) {
  runGit(['init'], rootDir);
  runGit(['config', 'user.email', 'smart-references@example.com'], rootDir);
  runGit(['config', 'user.name', 'SmartReferencesTests'], rootDir);
  runGit(['add', '.'], rootDir);
}

function createWorkspace(kind, tempRoot) {
  const rootDir = fs.mkdtempSync(path.join(tempRoot, `smart-references-${kind}-`));
  const files = kind === 'cpp-project'
    ? {
        '.gitignore': 'ignored/\n',
        'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(SmokeTest)\n',
        'src/main.cpp': 'int main() { return 0; }\n',
        'include/main.h': '#pragma once\n',
        'tests/main_test.cpp': 'int run_test() { return 0; }\n',
        'ignored/cache.txt': 'ignored\n',
      }
    : {
        '.gitignore': 'ignored/\n',
        'README.md': '# Plain Workspace\n',
        'src/app.js': 'export const app = 1;\n',
        'ignored/cache.txt': 'ignored\n',
      };
  writeWorkspaceFiles(rootDir, files);
  initGitRepo(rootDir);
  return rootDir;
}

async function runSuiteForWorkspace(kind) {
  const vscodeExecutablePath = resolveVsCodeExecutablePath();
  const tempRoot = getTempRootForExecutable(vscodeExecutablePath);
  const workspaceDir = createWorkspace(kind, tempRoot);
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, `smart-references-user-${kind}-`));
  const extensionsDir = fs.mkdtempSync(path.join(tempRoot, `smart-references-ext-${kind}-`));
  const markerPath = path.resolve(__dirname, 'vscode', '.project-explorer-suite-ran.json');
  writeUserSettings(userDataDir, vscodeExecutablePath);
  const workspaceArg = convertPathForExecutable(workspaceDir, vscodeExecutablePath);
  const userDataArg = convertPathForExecutable(userDataDir, vscodeExecutablePath);
  const extensionsArg = convertPathForExecutable(extensionsDir, vscodeExecutablePath);
  const extensionDevelopmentPath = convertPathForExecutable(path.resolve(__dirname, '..'), vscodeExecutablePath);
  const extensionTestsPath = convertPathForExecutable(path.resolve(__dirname, 'vscode', 'suite', 'index.js'), vscodeExecutablePath);

  try {
    fs.rmSync(markerPath, { force: true });

    let timeoutId;
    try {
      await Promise.race([
        runTests({
          vscodeExecutablePath,
          extensionDevelopmentPath,
          extensionTestsPath,
          launchArgs: [
            workspaceArg,
            '--disable-extensions',
            '--skip-welcome',
            '--skip-release-notes',
            '--disable-workspace-trust',
            `--user-data-dir=${userDataArg}`,
            `--extensions-dir=${extensionsArg}`,
          ],
        }),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Extension host suite timed out for ${kind}`)), 60000);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!fs.existsSync(markerPath)) {
      throw new Error(`Extension host suite did not create marker for ${kind}`);
    }

    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const expectedCpp = kind === 'cpp-project';
    if (marker.expectCppProject !== expectedCpp) {
      throw new Error(`Extension host suite wrote unexpected marker payload for ${kind}`);
    }
  } finally {
    cleanupTrackedProcesses([workspaceArg, userDataArg, extensionsArg], vscodeExecutablePath);
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extensionsDir, { recursive: true, force: true });
    fs.rmSync(markerPath, { force: true });
  }
}

async function main() {
  await runSuiteForWorkspace('cpp-project');
  await runSuiteForWorkspace('plain-workspace');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
