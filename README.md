# Smart References

IntelliJ 风格的引用查找插件，将 VSCode 的引用结果按**定义、实现、导入、字段声明、参数类型、返回类型、实例化、读写访问、注释、测试**分类展示，并支持跨多次查询的历史导航。

## 功能

### Find Smart References（Alt+F7）

对光标下的符号执行引用查找，结果按以下分类在侧边栏树视图中展示：

| 分类 | 说明 |
|------|------|
| Definitions | 符号定义处 |
| Implementations | 接口/抽象方法的实现 |
| Imports | import / require / #include |
| Field declarations | 结构体/类字段类型标注 |
| Parameter types | 函数参数类型标注 |
| Return types | 函数返回类型标注 |
| Instantiations | `new MyClass(...)` 等实例化 |
| References | 普通读写引用（标注 `[read]` / `[write]`） |
| Tests | 测试文件中的引用 |
| Comments | 注释中的引用 |

树结构层级：**分类 → 目录 → 文件 → 所在方法 → 引用行**

悬停引用行可查看上下文代码片段；单击跳转到对应位置（在右侧预览窗口打开）。

`References` 视图标题栏支持 `$(filter)` 过滤按钮，可在 `All / Production / Tests / Current File / Current Directory / Workspace Source` 之间切换。`Current File / Current Directory` 会锚定在发起查询的文件或目录，不会因为你继续点击结果而刷新整棵引用树。

`Workspace Source` 会默认排除 `.d.ts` 以及常见生成目录，例如 `dist/`、`out/`、`build/`、`node_modules/`、`vendor/`。

同一位置还支持 `Group References` 分组按钮，可在“按目录树分组”和“按文件直接分组”之间切换，适合在大仓库里快速压缩导航层级。

结果确认有价值后，可用标题栏的 `Pin Reference Results` 固定当前结果集；`Open Pinned Reference Results` 可重新打开已固定结果，并在弹窗里直接删除不再需要的快照。

### Show Type Hierarchy（Ctrl+Shift+F12）

查找光标下类型/接口的所有实现，结果按 SymbolKind 分类（Class、Interface、Method、Function、Struct、Enum 等），并区分生产代码与测试代码。

### History Navigation（← →）

两个视图各自独立维护最多 20 条查询历史。在视图标题栏点击 `←` / `→` 可在多次查询结果之间前后切换，类似浏览器的 Back/Forward。

### CodeLens

在函数/类定义上方显示引用计数，点击直接触发 Find Smart References。

### Symbol Search（Shift+Shift / Ctrl+Shift+T / Ctrl+Alt+T）

快速跳转到工作区内的符号：

| 快捷键 | 搜索范围 |
|--------|---------|
| `Shift+Shift` | 所有符号 |
| `Ctrl+Shift+T` | 函数 / 方法 |
| `Ctrl+Alt+T` | 类型（class、interface、enum、struct） |

- 空查询时显示当前文件符号与最近访问记录
- 结果分为生产代码与测试代码（`$(beaker) Tests` 分隔符后）
- 自动识别工作区主语言，优先显示对应语言的符号
- 在 `.proto` 文件中搜索时，会先按当前项目主语言将 proto 名称转换为目标语言常见符号后再搜索

### Layered Text Search

独立于符号搜索和引用搜索，新增底部 **Layered Search** 面板，用于解决 VS Code 原生全文搜索结果层级不清晰的问题。这个功能只做**文本命中**展示，不参与符号分类，也不替代 `Find Smart References`。

入口：

- 命令面板执行 `Layered Text Search`
- 打开底部 **Layered Search** 面板后，点击标题栏搜索按钮
- 如果编辑器里有选中文本，搜索框会默认带入当前选中内容

结果结构：

- 单工作区：**目录树 → 文件 → 命中行**
- 多工作区：**工作区 → 目录树 → 文件 → 命中行**
- 点击命中行会在编辑器里预览并高亮对应位置

当前行为：

- 使用本机 `rg`（ripgrep）执行搜索，因此机器上需要能直接调用 `rg`
- 当前走**固定字符串搜索**，不是正则搜索
- 默认沿用 ripgrep 的忽略规则，例如 `.gitignore`、隐藏文件和常见忽略目录
- 面板标题栏提供“重新发起搜索”和“刷新当前查询”两个入口

适用场景：

- 在资源较大的 TS/JS 工程里按目录树查看某个字符串、配置项、事件名、接口名的分布
- 想保留搜索结果的目录上下文，而不是只看扁平文件列表
- 需要和 `Find Smart References` 区分开：前者看**语义引用**，这里看**原始文本命中**

### Dependency Symbol Search（Shift+Ctrl+Alt+T）

在所有依赖包源码中搜索符号（gopls 默认不索引 GOMODCACHE）：

- 首次打开时后台构建正则索引，QuickPick 显示 busy 状态
- 只搜索函数/方法、类型（struct）、接口，不含变量/常量
- 支持 Go（GOMODCACHE）；架构可扩展至 npm/Cargo

### Dependencies 面板

侧边栏新增 **Dependencies** 视图，展示 go.mod 依赖列表及各依赖的源码文件树：

- 有本地缓存的依赖可展开查看文件树，点击文件直接在编辑器打开
- 未下载的依赖显示 `(not downloaded)` 不可展开
- 直接依赖优先，间接依赖靠后；go.mod 变化时自动刷新
- 架构支持后续扩展 npm（package.json）、Cargo（Cargo.toml）等

### go.mod 链接

在 go.mod 文件中，点击依赖的版本字符串（如 `v1.2.3`）直接在编辑器中打开对应模块的 GOMODCACHE 源文件，而非浏览器。

### Protobuf 符号映射

在 `*.proto` 文件中，插件会优先把 proto 符号映射为当前项目语言中的常见目标符号，再执行查找：

- `Search Symbol`
- `Find Smart References`
- `Show Type Hierarchy / Find Implementations`
- VS Code 原生 `Go to Definition / Find References / Go to Implementation`

首批覆盖 `Go / C# / Java / Kotlin / JavaScript / TypeScript / Python / Rust`。

`Find Smart References` 中，`.proto` 文件里的命中会进入独立的 `Proto` 分组，不再混入普通读写分类。

示例：

- `user_id` 在 Go 中优先搜索 `UserId`、`GetUserId`
- `user_id` 在 Java/Kotlin/JS/TS 中优先搜索 `userId`、`getUserId`、`setUserId`
- `user_id` 在 Python 中保持 `user_id`

当前已按 protobuf 官方文档区分 `proto2` / `proto3` 的关键差异：

- `proto2` singular 字段默认带 presence，`proto3` 不是
- `proto3` 普通标量字段不会盲目补 `hasXxx`
- `proto3 optional`、`oneof`、message 字段会保留 presence 相关别名
- `proto2` 的 `extend` / `group` 已做基础语法识别

规则按语言和语法版本拆分实现，后续可以继续扩展，不需要重写主查找链路。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Alt+F7` | Find Smart References |
| `Ctrl+Shift+F12` | Show Type Hierarchy |
| `Shift+Shift` | Search Symbol（全部） |
| `Ctrl+Shift+T` | Search Function / Method |
| `Ctrl+Alt+T` | Search Type |
| `Shift+Ctrl+Alt+T` | Search Dependency Symbols |
| 无默认快捷键 | Layered Text Search |

右键菜单也提供 Find Smart References 和 Show Type Hierarchy 入口。

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `smartReferences.testFilePatterns` | 内置多语言模式 | 识别测试文件的 glob 列表 |
| `smartReferences.enableCodeLens` | `true` | 是否显示 CodeLens 引用计数 |
| `smartReferences.enableReadWriteClassification` | `true` | 是否区分读/写访问 |
| `smartReferences.enableCommentDetection` | `true` | 是否检测注释中的引用 |
| `smartReferences.symbolSearch.maxResultsPerCategory` | `15` | 每分类最多显示的符号数 |
| `smartReferences.symbolSearch.debounceMs` | `150` | 符号搜索防抖延迟（ms） |

### 默认测试文件识别规则

开箱支持 Go、TypeScript/JavaScript、Python、Java、Kotlin、Rust、C#：

```
**/*_test.go
**/*.{test,spec}.{ts,tsx,js,jsx}
**/__tests__/**
**/test_*.py  /  **/*_test.py  /  **/tests/**/*.py
**/src/test/**
**/*Test.java  /  **/*Test.kt
**/tests/**/*.rs
**/*Tests.cs  /  **/*.Tests/**
```

## 多语言支持

插件复用 VSCode 已加载的 LSP，不额外启动新语言服务器。

- **Go / TypeScript / JavaScript / Python / Java / Kotlin / Rust / C# / Vue**：全分类支持
- **C++**：支持 `#include` 识别为 Import，返回类型使用前置写法检测
- **Lua 及其他**：无专属规则，引用统一归入 References 分类

## 依赖跳转支持

除通用引用查找外，插件还为各语言的依赖文件提供可点击链接和定义跳转：

| 语言 | 链接 / 跳转 |
|------|------------|
| Go | `go.mod` 版本号 → GOMODCACHE 源文件 |
| C# | `using` 语句 → NuGet / Unity 包源文件 |
| C# | `typeof(T)` / `: Base` → 工作区或包中的类型声明（`DefinitionProvider`，F12 / Ctrl+Click） |
| C# | `.csproj` `<PackageReference>` → NuGet / Unity 包源文件 |
| Python | `import` / `from ... import` → site-packages 源文件 |

C# 依赖解析顺序：Unity `Library/PackageCache` → `Packages/`（本地包）→ NuGet `~/.nuget/packages/`。
Python 依赖解析顺序：激活的解释器 site-packages → venv / `.venv` → 常用系统路径。

## 开发

### 前置要求

- Node.js ≥ 18
- VS Code ≥ 1.80

### 本地调试

```bash
npm install
npm run compile   # 编译一次
npm run watch     # 监听文件变更，自动增量编译
```

在 VS Code 中按 `F5` 启动 **Extension Development Host**，在新窗口中实时测试插件。

## 打包与安装

### 安装打包工具

```bash
npm install -g @vscode/vsce
```

### 打包 .vsix

```bash
# 编译后打包
npm run compile
vsce package
# 生成 vscode-intellij-style-references-<version>.vsix
```

或通过 npm script 一步完成（会自动调用已全局安装的 vsce）：

```bash
npm run package
```

### 本地安装

```bash
# 方式一：命令行
code --install-extension vscode-intellij-style-references-0.1.0.vsix

# 方式二：VS Code UI
# Extensions 面板 → "..." → Install from VSIX...
```

### 更新版本号

打包前先在 `package.json` 中更新 `version` 字段，或使用 `vsce` 内置命令：

```bash
vsce publish patch   # 0.1.0 → 0.1.1（不发布，仅演示命令）
```

直接修改 `package.json` 中的 `version` 再 `vsce package` 即可，无需连接 Marketplace。

### 典型发布流程

```bash
# 1. 修改代码，确认编译通过
npm run compile

# 2. 更新 package.json 中的 version

# 3. 打包
vsce package

# 4. 安装到本地验证
code --install-extension *.vsix

# 5. 提交并打 tag
git add .
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
```
