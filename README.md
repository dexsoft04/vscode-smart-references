# IntelliJ-Style Dev

Bring JetBrains / IntelliJ IDEA's powerful navigation features to VS Code — **Find Usages** with smart classification, **Type Hierarchy**, **Enhanced Text Search** with sequential replace, **File Structure**, **Symbol Search** (double-Shift), **Dependency Explorer**, **CodeLens** reference counts, and **inline translation**. Works with any language that has an LSP (Go, TypeScript, JavaScript, Python, Java, Kotlin, Rust, C#, C++, and more).

---

IntelliJ 风格的 VSCode 开发工具箱——分类引用查找、搜索增强、类型层级、文件结构、依赖浏览、翻译等一站式开发体验。支持中英双语界面。

## Features / 功能一览

| Feature | Shortcut | Description |
|---------|----------|-------------|
| **Find Smart References** | `Alt+F7` | Classified references: Definitions, Implementations, Imports, Read/Write, Tests, Comments |
| **Find Implementations** | `Alt+F8` | Type hierarchy by SymbolKind, single-impl jumps directly |
| **Symbol Search** | `Shift+Shift` | Quick jump to any symbol in workspace, with recent history |
| **Search Function** | `Ctrl+Shift+T` | Search functions and methods only |
| **Search Type** | `Ctrl+Alt+T` | Search classes, interfaces, enums, structs |
| **Enhanced Search** | `Ctrl+Alt+U` | Ripgrep-powered text search with code/comment/config grouping and sequential replace |
| **Translate** | `Alt+A` | Inline translation for comments (Google, DeepL, Baidu, Claude) |
| **File Structure** | Command Palette | Outline view with Go receiver grouping, JSON/YAML/TOML/Markdown built-in parsing |
| **Dependency Explorer** | Sidebar | Browse go.mod / dependency source files |
| **CodeLens** | — | Reference counts above functions, `no tests` / `no references` warnings |
| **Inlay Hints** | — | `← N impls` hints on type definitions |
| **Project Files** | Panel | Git-aware file tree with compact directories, layout modes |

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

引用树顶部会展示一条摘要行，显示当前过滤后结果的统计信息，例如 `12 refs · 4 files · 2 dirs · 3 in tests`，方便在修改前快速评估影响范围。当关键词过滤生效时，摘要行同步显示当前过滤词。

`References` 视图标题栏按钮：

| 按钮 | 功能 |
|------|------|
| `$(filter)` | 切换作用域：`All / Production / Tests / Current File / Current Directory / Workspace Source` |
| `$(list-tree)` | 切换分组方式：按目录树 / 按文件 |
| `$(search)` | 在当前结果内按关键词过滤，匹配引用行文本或所在方法名；再次触发并清空可取消过滤 |
| `$(export)` | 将当前引用树导出为 Markdown 并复制到剪贴板，便于代码评审或团队分享 |
| `$(pinned)` | 固定当前结果快照 |
| `$(history)` | 查看已固定的结果列表 |

`Current File / Current Directory` 会锚定在发起查询的文件或目录，不会因为你继续点击结果而刷新整棵引用树。`Workspace Source` 会默认排除 `.d.ts` 以及常见生成目录，例如 `dist/`、`out/`、`build/`、`node_modules/`、`vendor/`。

固定结果（Pin）支持为每条快照添加文字备注。打开已固定结果列表时，点击每项旁边的 `$(edit)` 按钮即可输入或修改备注，备注会显示在列表的详情行中。Pin 数据（含备注）跨会话持久化，重新打开 VS Code 后仍可恢复。

### Project Files

`Project Files` 会按工程文件树展示源码、测试和已忽略文件。现在它和 **搜索增强** 一样使用独立面板容器，默认出现在底部 Panel，也可以按 VS Code 原生方式自由拖拽到侧边栏、辅助侧边栏或其他面板区域。当前目录链上如果每一级都只有**一个子目录且没有同级文件**，会自动压缩成一条紧凑路径，效果接近 IDEA 的 compact directories。

视图模式：

- `Merged Tree`：所有已跟踪文件共用一棵目录树
- `Sources / Tests`：按源码和测试拆分
- `Project Layout`：按工程语义分组，适合 C / C++ / Objective-C / Swift / Kotlin / Rust / C# / Java 这类工程型仓库
- `Hotspot Files`：按本次会话引用查询的命中频率排序文件，出现次数越多排越靠前，每行显示命中次数；仅统计当前 session 数据，无额外后台计算

`Project Layout` 会优先把文件分到 `Tests / Modules / Headers / Build / Third-Party`。其中 `Build` 会识别 `CMakeLists.txt`、`Makefile`、`*.mk`、`*.sln`、`*.vcxproj`、`*.csproj`、`Package.swift`、`Cargo.toml`、`pom.xml`、`build.gradle(.kts)` 等常见工程入口；同一 workspace 检测到多个子工程时，会先按 `项目名 -> 分类` 分层显示。默认测试模式覆盖 C/C++、Objective-C、Swift、Kotlin、Rust、C#、Java 的常见命名；在 `Merged Tree` 下，只有和源码同目录的测试文件会弱化，`src/test/**`、`tests/**`、`Tests/**`、`benches/**` 这类专用测试目录保持正常显示。生成文件不再单独成组：生成头文件并入 `Headers`，生成源码和其他生成物并入 `Modules`，同时复用 ignored file 的弱化样式。`文档 / 其他 / 脚本与工具` 不再单独成组，而是直接并入 `Modules`。

边界：

- 只会压缩连续的“单子目录链”；一旦某一级目录下同时存在多个子目录，或存在文件，压缩就在这一层停止。
- 压缩只影响显示标签，不改变真实文件路径，也不影响点击打开和 reveal 行为。
- `ignored` 分类同样会应用这条目录压缩规则，但目录内容仍然按真实文件系统递归展开。
- 当某条目录链被压缩后，树节点 tooltip 仍显示完整相对路径，方便确认真实位置。

### Find Implementations（Alt+F8）

查找光标下类型/接口的所有实现，结果按 SymbolKind 分类（Class、Interface、Method、Function、Struct、Enum 等），并区分生产代码与测试代码。

当只有一个实现时，直接跳转到目标位置；多个实现时展示完整的类型层级树。

### History Navigation（← →）

两个视图各自独立维护最多 20 条查询历史。在视图标题栏点击 `←` / `→` 可在多次查询结果之间前后切换，类似浏览器的 Back/Forward。

### Inlay Hints

在类型/接口定义行末尾显示实现数量提示（← N impls）。接口显示实现计数，方法/函数显示实现类名。点击提示可跳转到对应实现。可通过 `smartReferences.enableImplInlayHints` 开关。

### CodeLens

在函数/类定义上方显示引用计数，点击直接触发 Find Smart References。有引用但无测试覆盖时，会额外显示 `· no tests`；引用数为零时显示 `$(circle-slash) no references`，便于识别死代码。

### Test File Decoration

在 VS Code 原生资源管理器和 Project Files 中弱化测试文件显示（降低前景色、添加 `T` 标记），帮助视觉上区分生产代码与测试代码。可通过 `smartReferences.enableTestFileDecoration` 开关。

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

### 搜索增强（Ctrl+Alt+U）

独立于符号搜索和语义引用搜索，底部新增 **搜索增强** 面板，专门解决 VS Code 原生全文搜索“结果噪声太多、层次不清、定位成本高”的问题。它只处理**文本命中**，不参与符号分类，也不替代 `Find Smart References`。

入口：

- 命令面板执行 `Enhanced Text Search`，或直接按 `Ctrl+Alt+U`
- 命令会先聚焦底部 **搜索增强** 视图，再通过原生 `InputBox` 输入搜索词
- 如果编辑器里有选中文本，会自动作为默认搜索词
- 搜索弹窗提供原生按钮：`include / exclude / 分组` 在输入框外侧，`Aa / ab / .* / 模糊` 使用 VS Code 原生 toggle API 嵌入输入框内部，选中/未选中态跟随主题自动切换
- 搜索结果视图标题栏显示当前搜索条件（查询词、选项、过滤规则），并保留 `编辑搜索条件 / 刷新 / 顺序替换当前结果 / 撤销上次替换` 等动作入口

结果结构：

- 结果固定为原生树视图：`分类 → 文件 → 命中行 → 上下文`
- 默认使用 **组合分组**，优先拆开 `代码 · 代码文件`、`注释 · 代码文件`、`代码 · 配置文件`、`注释 · 配置文件`
- 分类默认展开，文件默认折叠，先压低噪声，再按需深入
- 文件节点只显示一条相对路径，右侧显示命中数，不再展开目录树
- 同一文件内的命中按行号升序；文件按“命中数倒序 + 路径升序”排列，优先把最值得看的文件顶上来
- 命中行会在原生树节点中直接高亮匹配片段；有上下文时可展开查看上文/下文
- 多工作区场景下，会在分组下额外保留 workspace 层；单工作区默认直接显示文件节点

查找规则：

- 使用内置的 ripgrep（`@vscode/ripgrep`）执行文本搜索，无需额外安装
- 默认查找/排除规则与 VS Code 搜索配置保持一致，会读取 `search.exclude`、`files.exclude`，并跟随 `search.useIgnoreFiles`、`search.useGlobalIgnoreFiles`、`search.useParentIgnoreFiles`、`search.followSymlinks`、`search.smartCase`
- 对 `search.exclude` / `files.exclude` 的对象型条件规则，例如 `{"**/*.js": {"when": "$(basename).ts"}}`，也会按 VS Code 语义生效
- `include`、`exclude`、模糊搜索和分组都可以直接在搜索弹窗右上角这一排单独设置；上下文行数只保留在插件设置中配置
- 搜索弹窗会保留最近搜索历史，默认 20 条；可直接用上下方向键或鼠标滚轮在历史间切换，条数可通过 `smartReferences.textSearch.historySize` 配置
- 默认**不是模糊搜索**
- 模糊搜索带有文件扫描上限和结果上限，可通过 `smartReferences.textSearch.maxFuzzyFileScan` 和 `smartReferences.textSearch.maxFuzzyMatches` 调整

顺序替换：

- 支持在当前结果树上执行 `替换当前命中` 和 `顺序替换当前结果`
- 替换严格按当前显示顺序执行：`分类 → 文件 → 命中`
- 任意一条失败立即停止，不做批量原子提交
- 输入替换文本后，会先弹出原生确认/取消对话框，再真正执行替换
- 每一条替换都会写入 `IntelliJ-Style Dev` 输出通道，并带上唯一替换 ID，记录文件、行号、原命中、替换内容和失败原因，便于审计和回溯
- 标题栏提供 `撤销上次替换`，会按最近一批替换的 ID 做安全回滚；如果文件在替换后又被修改，会拒绝回滚
- 模糊搜索结果不可替换

边界与范围：

- 搜索增强只处理**文本命中**，不会判断符号语义，因此它不能替代 `Find Smart References` 的定义 / 实现 / 读写分类。
- `代码 / 注释 / 配置文件` 分组只影响当前结果树的展示与替换范围，不会改变底层文件内容的归属。
- 同一个文件可以同时出现在多个分组中，例如同一文件既有代码命中，也有注释命中。
- 对某个**分组**执行替换时，只会替换该分组下当前展示的命中；不会顺带替换同一文件落在其他分组中的命中。
- 对某个**文件**执行替换时，会替换该文件在当前结果集中的全部命中；如果当前采用 `代码 / 注释` 或组合分组，这意味着代码命中和注释命中都会一起替换。
- `顺序替换当前结果` 会覆盖当前结果树中的全部命中，因此会跨分组执行；如果你只想替换代码命中，应在代码分组节点上执行“替换当前分组”。
- 替换范围始终以**当前结果树实际展示出来的结果集**为准；只要改了 `query / include / exclude / Aa / ab / .* / 模糊 / 分组` 这类会影响结果集的条件，就需要重新搜索后才能替换。
- 上下文行只是预览信息，不会单独参与替换；展开后看到的上文/下文不会被当成额外替换目标。
- 撤销替换是按最近一批替换 ID 做整批安全回滚，不是普通编辑器级别的盲目 Undo。
- 撤销确认框里显示的是这批替换**实际应用后的文件与行号**；如果替换前面的内容引入或删除了换行，后续行号会按替换后的真实位置展示。
- 只有当相关文件仍然保持这批替换完成后的内容时，撤销才会执行；如果你在替换后又手动编辑了文件，插件会拒绝回滚，避免覆盖后续改动。
- 模糊搜索只用于浏览和定位，不支持替换，也不会参与撤销链路。

适用场景：

- 在大型 TS/JS 工程里按相对路径快速浏览事件名、接口名、配置项、埋点名、常量名的分布
- 想保留路径上下文，但又不想让目录树本身淹没结果
- 需要先按“代码 / 注释 / 配置文件”降噪，再决定从哪个文件切进去
- 需要安全地按当前结果顺序逐条替换，并通过日志追踪整个过程

### Structure 面板

底部 Panel 中的文件结构视图，显示当前打开文件的类、方法、字段、常量等符号树。

- Go 语言会自动按接收者类型分组方法
- 对 JSON、YAML、TOML、Markdown 等结构化文本格式提供内置解析，不依赖语言服务器
- 显示方法签名和行内文档注释
- 文件变更时自动刷新

右键菜单或命令面板执行 `Show File Structure` 打开。

### Translate（Alt+A）

行内翻译，将光标所在的注释或选中文本翻译为中文并以双语格式展示。

支持以下翻译引擎：

| 引擎 | 说明 |
|------|------|
| `google-free` | Google 免费翻译（默认，无需 API Key） |
| `baidu` | 百度翻译（需 AppID + SecretKey） |
| `deepl` | DeepL（需 API Key） |
| `claude` | Claude / Anthropic（需 API Key） |
| `google` | Google Cloud Translation API（需 API Key） |

- 智能识别注释范围（基于语义 Token 或正则回退），自动去除注释语法
- 跳过已是中文的文本
- 可通过 `smartReferences.translation.skipProjectFiles` 阻止在项目配置文件上触发

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
| `Alt+F8` | Find Implementations |
| `Shift+Shift` | Search Symbol（全部） |
| `Ctrl+Shift+T` | Search Function / Method |
| `Ctrl+Alt+T` | Search Type |
| `Shift+Ctrl+Alt+T` | Search Dependency Symbols |
| `Ctrl+Alt+U` | Enhanced Search（搜索增强） |
| `Alt+A` | Translate（翻译） |

右键菜单也提供 Find Smart References、Find Implementations、Show File Structure 和 Search with Enhanced Search 入口。

## 配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `smartReferences.testFilePatterns` | 内置多语言模式 | 识别测试文件的 glob 列表 |
| `smartReferences.enableCodeLens` | `true` | 是否显示 CodeLens 引用计数 |
| `smartReferences.enableReadWriteClassification` | `true` | 是否区分读/写访问 |
| `smartReferences.enableCommentDetection` | `true` | 是否检测注释中的引用 |
| `smartReferences.enableImplInlayHints` | `true` | 是否在类型定义行显示实现数量提示 |
| `smartReferences.enableTestFileDecoration` | `true` | 是否在资源管理器中弱化测试文件 |
| `smartReferences.translation.provider` | `"google-free"` | 翻译引擎：google-free / baidu / deepl / claude / google |
| `smartReferences.translation.skipProjectFiles` | `false` | 是否阻止在项目配置文件上触发翻译 |
| `smartReferences.translation.baiduCredentials` | `""` | 百度翻译凭证（格式：`AppID:SecretKey`） |
| `smartReferences.translation.deepLApiKey` | `""` | DeepL API Key |
| `smartReferences.translation.claudeApiKey` | `""` | Claude / Anthropic API Key |
| `smartReferences.translation.googleApiKey` | `""` | Google Cloud Translation API Key |
| `smartReferences.symbolSearch.maxResultsPerCategory` | `15` | 每分类最多显示的符号数 |
| `smartReferences.symbolSearch.debounceMs` | `150` | 符号搜索防抖延迟（ms） |
| `smartReferences.textSearch.beforeContextLines` | `2` | 文本搜索命中前显示多少行上下文 |
| `smartReferences.textSearch.afterContextLines` | `3` | 文本搜索命中后显示多少行上下文 |
| `smartReferences.textSearch.includeGlobs` | `[]` | 文本搜索额外包含的 glob 规则 |
| `smartReferences.textSearch.excludeGlobs` | `[]` | 文本搜索额外排除的 glob 规则，叠加在 VS Code 默认排除规则之上 |
| `smartReferences.textSearch.fuzzySearch` | `false` | 是否启用模糊子序列搜索 |
| `smartReferences.textSearch.historySize` | `20` | 搜索增强保留多少条最近搜索历史 |
| `smartReferences.textSearch.maxFuzzyFileScan` | `2000` | 模糊搜索最多扫描多少个文件 |
| `smartReferences.textSearch.maxFuzzyMatches` | `1000` | 模糊搜索最多收集多少条命中 |
| `smartReferences.textSearch.groupCodeAndComments` | `true` | 是否把代码命中和注释命中分栏显示 |
| `smartReferences.textSearch.groupConfigAndCodeFiles` | `true` | 是否把配置文件和代码文件分栏显示 |

### 默认测试文件识别规则

开箱支持 Go、TypeScript/JavaScript、Python、Java、Kotlin、C/C++、Objective-C、Swift、Rust、C#：

```
**/*_test.go
**/*.{test,spec}.{ts,tsx,js,jsx}
**/__tests__/**
**/test_*.py  /  **/*_test.py  /  **/tests/**/*.py
**/src/test/**
**/*Test.java
**/*Test.kt  /  **/*Tests.kt  /  **/*Spec.kt  /  **/src/test/**/*.kt
**/*_test.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}  /  **/*.{test,spec}.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}
**/*Test.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}  /  **/*Tests.{c,cc,cpp,cxx,h,hh,hpp,hxx,m,mm}
**/*Test.swift  /  **/*Tests.swift  /  **/*Spec.swift  /  **/Tests/**/*.swift
**/*_test.rs  /  **/*_tests.rs  /  **/tests/**/*.rs  /  **/benches/**/*.rs
**/*Test.cs  /  **/*Tests.cs  /  **/Tests/**/*.cs  /  **/*.Tests/**
```

## 国际化

插件界面支持英文和简体中文，跟随 VS Code 的 `locale` 设置自动切换。

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
- VS Code ≥ 1.98

### 运行时依赖

| 依赖 | 说明 | 安装方式 |
|------|------|---------|
| `@vscode/ripgrep` | 搜索增强使用的 ripgrep 二进制，随扩展内置 | `npm install` 自动安装，无需手动配置 |

> ripgrep 已通过 `@vscode/ripgrep` 包内置在扩展中，用户无需在系统 PATH 中单独安装 `rg`。

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
# 生成 vscode-intellij-style-dev-<version>.vsix
```

或通过 npm script 一步完成（会自动调用已全局安装的 vsce）：

```bash
npm run package
```

### 本地安装

```bash
# 方式一：命令行
code --install-extension vscode-intellij-style-dev-0.1.0.vsix

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

## License

[MIT](LICENSE)
