# VS Code 内置开发常用命令配置

本文档整理一套适合日常开发的 VS Code 内置命令快捷键配置，目标是把高频编辑、导航、搜索、终端、任务、调试命令集中到一份可维护的清单里。

约束说明：

- 只使用 VS Code 内置命令，不依赖第三方扩展。
- 文档本身不会自动生效；需要手动复制到你的 `keybindings.json`。
- 以下按 Windows / Linux 快捷键习惯编排；macOS 通常将 `Ctrl` 替换为 `Cmd`，将 `Alt` 替换为 `Option`。
- Linux 桌面环境经常会占用 `Ctrl+Alt+方向键`、`Ctrl+Alt+Space`、`Ctrl+Alt+T` 等组合键；如果落地后没有生效，应优先检查系统快捷键冲突，而不是怀疑命令 ID 本身有问题。

## 使用方式

1. 在 VS Code 中执行 `Preferences: Open Keyboard Shortcuts (JSON)`。
2. 将下方 JSON 条目按需复制进去。
3. 如果某些快捷键与你已有习惯冲突，优先保留你现有高频链路。

## 推荐配置

```json
[
  {
    "key": "alt+enter",
    "command": "editor.action.quickFix",
    "when": "editorHasCodeActionsProvider && textInputFocus && !editorReadonly"
  },
  {
    "key": "ctrl+alt+l",
    "command": "editor.action.formatDocument",
    "when": "editorHasDocumentFormattingProvider && editorTextFocus && !editorReadonly"
  },
  {
    "key": "ctrl+alt+o",
    "command": "editor.action.organizeImports",
    "when": "textInputFocus && !editorReadonly && supportedCodeAction =~ /(\\s|^)source\\.organizeImports\\b/"
  },
  {
    "key": "ctrl+alt+shift+l",
    "command": "editor.action.codeAction",
    "args": {
      "kind": "source.fixAll",
      "apply": "ifSingle"
    },
    "when": "textInputFocus && !editorReadonly && supportedCodeAction =~ /(\\s|^)source\\.fixAll\\b/"
  },
  {
    "key": "ctrl+alt+u",
    "command": "editor.action.transformToUppercase",
    "when": "editorTextFocus && !editorReadonly"
  },
  {
    "key": "ctrl+alt+shift+u",
    "command": "editor.action.transformToLowercase",
    "when": "editorTextFocus && !editorReadonly"
  },
  {
    "key": "ctrl+e",
    "command": "workbench.action.quickOpen"
  },
  {
    "key": "ctrl+shift+e",
    "command": "workbench.view.explorer"
  },
  {
    "key": "ctrl+shift+;",
    "command": "workbench.action.gotoSymbol"
  },
  {
    "key": "ctrl+;",
    "command": "workbench.action.showAllSymbols"
  },
  {
    "key": "ctrl+alt+b",
    "command": "editor.action.goToImplementation",
    "when": "editorHasImplementationProvider && editorTextFocus && !isInEmbeddedEditor"
  },
  {
    "key": "ctrl+shift+alt+b",
    "command": "editor.action.peekImplementation",
    "when": "editorHasImplementationProvider && editorTextFocus && !inReferenceSearchEditor && !isInEmbeddedEditor"
  },
  {
    "key": "ctrl+alt+f7",
    "command": "editor.action.goToReferences",
    "when": "editorHasReferenceProvider && editorTextFocus && !inReferenceSearchEditor && !isInEmbeddedEditor"
  },
  {
    "key": "ctrl+shift+alt+f7",
    "command": "editor.action.referenceSearch.trigger",
    "when": "editorHasReferenceProvider && editorTextFocus && !inReferenceSearchEditor && !isInEmbeddedEditor"
  },
  {
    "key": "ctrl+shift+t",
    "command": "workbench.action.reopenClosedEditor"
  },
  {
    "key": "ctrl+alt+left",
    "command": "workbench.action.navigateBack"
  },
  {
    "key": "ctrl+alt+right",
    "command": "workbench.action.navigateForward"
  },
  {
    "key": "ctrl+shift+up",
    "command": "editor.action.insertCursorAbove",
    "when": "editorTextFocus"
  },
  {
    "key": "ctrl+shift+down",
    "command": "editor.action.insertCursorBelow",
    "when": "editorTextFocus"
  },
  {
    "key": "ctrl+shift+alt+up",
    "command": "editor.action.moveLinesUpAction",
    "when": "editorTextFocus && !editorReadonly"
  },
  {
    "key": "ctrl+shift+alt+down",
    "command": "editor.action.moveLinesDownAction",
    "when": "editorTextFocus && !editorReadonly"
  },
  {
    "key": "ctrl+shift+/",
    "command": "editor.action.blockComment",
    "when": "editorTextFocus && !editorReadonly"
  },
  {
    "key": "ctrl+alt+space",
    "command": "editor.action.triggerSuggest",
    "when": "editorHasCompletionItemProvider && textInputFocus && !editorReadonly"
  },
  {
    "key": "ctrl+shift+space",
    "command": "editor.action.triggerParameterHints",
    "when": "editorTextFocus"
  },
  {
    "key": "ctrl+alt+h",
    "command": "editor.action.showHover",
    "when": "editorTextFocus"
  },
  {
    "key": "ctrl+alt+f",
    "command": "workbench.action.findInFiles"
  },
  {
    "key": "ctrl+alt+r",
    "command": "workbench.action.replaceInFiles"
  },
  {
    "key": "ctrl+alt+t",
    "command": "workbench.action.terminal.toggleTerminal"
  },
  {
    "key": "ctrl+shift+alt+t",
    "command": "workbench.action.terminal.new"
  },
  {
    "key": "ctrl+alt+enter",
    "command": "workbench.action.terminal.runSelectedText",
    "when": "editorTextFocus"
  },
  {
    "key": "ctrl+shift+b",
    "command": "workbench.action.tasks.build"
  },
  {
    "key": "ctrl+alt+shift+r",
    "command": "workbench.action.tasks.runTask"
  },
  {
    "key": "f5",
    "command": "workbench.action.debug.start"
  },
  {
    "key": "shift+f5",
    "command": "workbench.action.debug.stop"
  },
  {
    "key": "f10",
    "command": "editor.debug.action.stepOver"
  },
  {
    "key": "f11",
    "command": "editor.debug.action.stepInto"
  },
  {
    "key": "shift+f11",
    "command": "editor.debug.action.stepOut"
  },
  {
    "key": "ctrl+shift+g",
    "command": "workbench.view.scm"
  },
  {
    "key": "ctrl+shift+m",
    "command": "workbench.actions.view.problems"
  }
]
```

## 命令说明

### 编辑与重构

| 快捷键 | 命令 ID | 作用 |
| --- | --- | --- |
| `Alt+Enter` | `editor.action.quickFix` | 打开快速修复与 Code Action |
| `Ctrl+Alt+L` | `editor.action.formatDocument` | 格式化当前文件 |
| `Ctrl+Alt+O` | `editor.action.organizeImports` | 整理 import / using |
| `Ctrl+Alt+Shift+L` | `editor.action.codeAction` + `source.fixAll` | 尝试执行语言支持提供的 Fix All |
| `F2` | `editor.action.rename` | 重命名符号，VS Code 默认已支持 |
| `Ctrl+Alt+U` | `editor.action.transformToUppercase` | 将选中文本转为大写 |
| `Ctrl+Alt+Shift+U` | `editor.action.transformToLowercase` | 将选中文本转为小写 |
| `Ctrl+/` | `editor.action.commentLine` | 行注释，VS Code 默认已支持 |
| `Ctrl+Shift+/` | `editor.action.blockComment` | 块注释 |

### 导航与符号

| 快捷键 | 命令 ID | 作用 |
| --- | --- | --- |
| `Ctrl+E` | `workbench.action.quickOpen` | 快速打开文件 |
| `Ctrl+Shift+;` | `workbench.action.gotoSymbol` | 跳到当前文件符号 |
| `Ctrl+;` | `workbench.action.showAllSymbols` | 全局符号搜索 |
| `F12` | `editor.action.revealDefinition` | 跳到定义，VS Code 默认已支持 |
| `Alt+F12` | `editor.action.peekDefinition` | 预览定义，VS Code 默认已支持 |
| `Ctrl+Alt+B` | `editor.action.goToImplementation` | 跳到实现 |
| `Ctrl+Shift+Alt+B` | `editor.action.peekImplementation` | 预览实现 |
| `Ctrl+Alt+F7` | `editor.action.goToReferences` | 直接打开引用列表 |
| `Ctrl+Shift+Alt+F7` | `editor.action.referenceSearch.trigger` | 在 Peek 视图中查看引用 |
| `Ctrl+Alt+Left` | `workbench.action.navigateBack` | 返回上一个编辑位置 |
| `Ctrl+Alt+Right` | `workbench.action.navigateForward` | 前进到下一个编辑位置 |

### 多光标与编辑效率

| 快捷键 | 命令 ID | 作用 |
| --- | --- | --- |
| `Ctrl+Shift+Up` | `editor.action.insertCursorAbove` | 在上方插入光标 |
| `Ctrl+Shift+Down` | `editor.action.insertCursorBelow` | 在下方插入光标 |
| `Ctrl+D` | `editor.action.addSelectionToNextFindMatch` | 选中下一个相同词，VS Code 默认已支持 |
| `Ctrl+Shift+L` | `editor.action.selectHighlights` | 选中所有匹配项，VS Code 默认已支持 |
| `Shift+Alt+Down` | `editor.action.copyLinesDownAction` | 向下复制当前行或选区，VS Code 默认已支持 |
| `Ctrl+Shift+Alt+Up` | `editor.action.moveLinesUpAction` | 上移行 |
| `Ctrl+Shift+Alt+Down` | `editor.action.moveLinesDownAction` | 下移行 |

### 搜索与信息查看

| 快捷键 | 命令 ID | 作用 |
| --- | --- | --- |
| `Ctrl+F` | `actions.find` | 文件内查找，VS Code 默认已支持 |
| `Ctrl+H` | `editor.action.startFindReplaceAction` | 文件内替换，VS Code 默认已支持 |
| `Ctrl+Alt+F` | `workbench.action.findInFiles` | 全局搜索 |
| `Ctrl+Alt+R` | `workbench.action.replaceInFiles` | 全局替换 |
| `Ctrl+Alt+H` | `editor.action.showHover` | 主动显示 hover 信息 |
| `Ctrl+Alt+Space` | `editor.action.triggerSuggest` | 主动触发补全 |
| `Ctrl+Shift+Space` | `editor.action.triggerParameterHints` | 触发参数提示 |

### 终端、任务、调试

| 快捷键 | 命令 ID | 作用 |
| --- | --- | --- |
| `Ctrl+Alt+T` | `workbench.action.terminal.toggleTerminal` | 打开或关闭终端面板 |
| `Ctrl+Shift+Alt+T` | `workbench.action.terminal.new` | 新建终端 |
| `Ctrl+Alt+Enter` | `workbench.action.terminal.runSelectedText` | 将编辑器选中文本发送到终端 |
| `Ctrl+Shift+B` | `workbench.action.tasks.build` | 执行默认构建任务 |
| `Ctrl+Alt+Shift+R` | `workbench.action.tasks.runTask` | 选择并运行任务 |
| `F5` | `workbench.action.debug.start` | 启动调试 |
| `Shift+F5` | `workbench.action.debug.stop` | 停止调试 |
| `F10` | `editor.debug.action.stepOver` | 单步跳过 |
| `F11` | `editor.debug.action.stepInto` | 单步进入 |
| `Shift+F11` | `editor.debug.action.stepOut` | 单步跳出 |

### 面板与工作台

| 快捷键 | 命令 ID | 作用 |
| --- | --- | --- |
| `Ctrl+Shift+E` | `workbench.view.explorer` | 聚焦资源管理器 |
| `Ctrl+Shift+G` | `workbench.view.scm` | 聚焦 Git / SCM 面板 |
| `Ctrl+Shift+M` | `workbench.actions.view.problems` | 打开 Problems 面板 |
| `Ctrl+Shift+T` | `workbench.action.reopenClosedEditor` | 重新打开最近关闭的编辑器 |
| `Ctrl+Shift+P` | `workbench.action.showCommands` | 命令面板，VS Code 默认已支持 |

## 适合本项目的最小集合

如果你只想保留一组最常用、冲突较少的配置，建议至少启用下面这些：

- `editor.action.quickFix`
- `editor.action.formatDocument`
- `editor.action.organizeImports`
- `editor.action.codeAction` with `source.fixAll`
- `editor.action.goToImplementation`
- `editor.action.referenceSearch.trigger`
- `editor.action.transformToUppercase`
- `editor.action.transformToLowercase`
- `workbench.action.findInFiles`
- `workbench.action.terminal.toggleTerminal`
- `workbench.action.tasks.build`

## 与当前项目的关系

当前项目已经存在：

- [launch.json](/home/hello/wk/vscode-smart-references/.vscode/launch.json)
- [tasks.json](/home/hello/wk/vscode-smart-references/.vscode/tasks.json)

因此这份文档里的任务与调试命令可以直接与项目现有配置配合使用，例如：

- `Ctrl+Shift+B` 触发默认 `npm: compile`
- `F5` 触发扩展宿主调试

如果你后面希望，我可以继续补一份“适配你个人习惯的 `keybindings.json` 实际文件版本”，单独放到项目根目录供你直接引用。
