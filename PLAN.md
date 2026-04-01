# VSCode Smart References — 实施计划

## Context

VSCode 内置的 "Find All References" 只能按文件平铺列出引用，缺乏 IntelliJ IDEA "Find Usages" 的分类能力。调研确认市场上无现有解决方案（VSCode Issue #167187 有 63+ 赞仍未实现）。

本插件通过 VSCode 语言无关的 Provider API（底层走 LSP）实现引用分类，自动适用于所有支持 LSP 的语言（Go/TS/JS/Python/Rust/Java/C# 等）。

## API 可行性验证

| API | 状态 | 实际命令名 |
|-----|------|-----------|
| 引用查找 | ✅ | `vscode.executeReferenceProvider` → `Location[]` |
| 定义查找 | ✅ | `vscode.executeDefinitionProvider` → `Location[]` |
| 实现查找 | ✅ | `vscode.executeImplementationProvider` → `Location[]` |
| 读/写分类 | ✅ | `vscode.executeDocumentHighlights` → `DocumentHighlight[]`（含 kind: Read/Write/Text） |
| 语义令牌 | ✅ | `vscode.provideDocumentSemanticTokens` + `vscode.provideDocumentSemanticTokensLegend`（**注意：非 executeDocumentSemanticTokensProvider**） |
| 文档符号 | ✅ | `vscode.executeDocumentSymbolProvider` → `DocumentSymbol[]` |

所有 API 均为 VSCode 内置、语言无关。不支持某能力时自动降级，不会报错。

## 架构

```
vscode-smart-references/
├── src/
│   ├── extension.ts                        # 插件入口，注册命令和视图
│   ├── providers/
│   │   ├── ReferenceTreeProvider.ts        # TreeView 数据提供者（分类→文件→函数→引用）
│   │   ├── ReferenceLensProvider.ts        # CodeLens（行内引用计数）
│   │   └── ReferencePreviewManager.ts      # 右侧预览面板（点击引用→打开文件高亮定位）
│   ├── core/
│   │   ├── ReferenceClassifier.ts          # 引用分类协调器
│   │   ├── ReferenceTypes.ts               # 类型定义
│   │   ├── Cache.ts                        # 结果缓存（FIFO，上限 500 条）
│   │   └── concurrent.ts                   # 并发控制工具（限制 LSP 请求并发）
│   └── analyzers/
│       ├── DefinitionAnalyzer.ts           # 定义/实现检测
│       ├── HighlightAnalyzer.ts            # 读/写分类
│       ├── SemanticTokenAnalyzer.ts        # 注释检测
│       └── TestFileDetector.ts             # 测试文件识别（可配置 glob 模式）
├── tests/
│   └── test-utils.js                       # 纯函数单测（globToRegex, decodeTokens）
├── package.json
├── tsconfig.json
└── .vscodeignore
```

### 数据流

```
用户右键 → "Find Smart References" (或 Alt+Shift+U)
    ↓
1. executeReferenceProvider(uri, pos) → Location[]          ← 语言无关
2. executeDefinitionProvider(uri, pos) → Location[]         ← 语言无关
3. executeImplementationProvider(uri, pos) → Location[]     ← 语言无关
    ↓
4. 合并 & 去重（按 uri + range 精确匹配）
    ↓
5. 并行分类：
   ├── TestFileDetector.classify(uri)                → test / production
   ├── SemanticTokenAnalyzer.isInComment(uri, range) → comment / code
   └── HighlightAnalyzer.getKind(uri, pos)           → read / write / text
    ↓
6. ReferenceTreeProvider 渲染分类树
```

### 分类结果示例

```
Handler.ServeHTTP  (23 usages)
├── Definitions (1)
│   └── http/server.go:142  func (mux *ServeMux) ServeHTTP(...)
├── Implementations (3)
│   ├── handler/auth.go:56    func (h *AuthHandler) ServeHTTP(...)
│   └── handler/proxy.go:88  func (p *ProxyHandler) ServeHTTP(...)
├── Read Access (8)
│   ├── Production (6)
│   │   ├── router/mux.go:34     h.ServeHTTP(w, r)
│   │   └── ...
│   └── Tests (2)
│       └── handler/auth_test.go:77  h.ServeHTTP(rr, req)
├── Write Access (2)
│   └── config/setup.go:15    mux.Handler = newHandler
└── Comments (2)
    └── handler/doc.go:5  // ServeHTTP implements http.Handler
```

## 实施步骤

### Step 1 — 插件骨架 + 基础引用获取 ✅ 已完成

已创建：package.json、tsconfig.json、.vscodeignore、src/core/ReferenceTypes.ts

**package.json 要点：**
- commands: `smartReferences.findReferences`
- keybindings: `Alt+Shift+U`
- menus: 编辑器右键菜单
- views: 侧边栏 `smartReferencesTree`
- configuration: testFilePatterns / enableCodeLens / enableReadWriteClassification / enableCommentDetection

**ReferenceTypes.ts 类型：**
```typescript
enum ReferenceCategory { Definition, Implementation, ReadAccess, WriteAccess, Comment }
enum CodeContext { Production, Test }
interface ClassifiedReference {
  location: vscode.Location;
  category: ReferenceCategory;
  context: CodeContext;
  lineText: string;
}
function locationKey(loc): string  // uri + line + char 去重键
```

### Step 2 — TestFileDetector + 基础 TreeView

**新建文件：**
- `src/analyzers/TestFileDetector.ts` — 基于可配置 glob 模式判断文件是否为测试文件

内置默认模式覆盖主流语言（Go/JS/TS/Python/Java/Kotlin/Rust/C#），通过 `smartReferences.testFilePatterns` 配置项自定义。使用 `minimatch` 或 `picomatch` 进行匹配。

- `src/providers/ReferenceTreeProvider.ts` — 实现 `vscode.TreeDataProvider<ReferenceTreeItem>`

树结构：
```
ReferenceTreeItem (root: symbol name + count)
├── CategoryNode ("Definitions", "Read Access", ...)
│   ├── ContextNode ("Production", "Tests") — 仅在 ReadAccess/WriteAccess 下
│   │   └── ReferenceItem (file:line + code preview)
│   └── ReferenceItem
```

每个 ReferenceItem：
- `label`: 文件名:行号
- `description`: 该行代码内容（trimmed）
- `command`: 点击跳转到对应位置
- `iconPath`: 根据分类使用不同 ThemeIcon

### Step 3 — 定义/实现分类 + 去重

**新建文件：**
- `src/analyzers/DefinitionAnalyzer.ts`

核心逻辑：
1. 调用 `executeDefinitionProvider` 和 `executeImplementationProvider`
2. 按 `uri.toString() + range.start.line + range.start.character` 去重
3. 匹配到 definition → `Definition`，匹配到 implementation → `Implementation`
4. `executeImplementationProvider` 不可用时 try-catch 降级
5. definition 和 implementation 重叠时优先标记为 Definition

### Step 4 — 读/写分类（HighlightAnalyzer）

**新建文件：**
- `src/analyzers/HighlightAnalyzer.ts`

核心逻辑：
1. 将 references 按文件分组
2. 对每个文件中的引用位置调用 `vscode.executeDocumentHighlights`
3. 从返回的 `DocumentHighlight[]` 中匹配 range，读取 `kind`（Read=1, Write=2, Text=0）
4. LSP 不支持时降级为 Text

**注意**：`documentHighlights` 是相对于某个符号位置的，需用引用位置来查询。

### Step 5 — 注释检测（SemanticTokenAnalyzer）

**新建文件：**
- `src/analyzers/SemanticTokenAnalyzer.ts`

核心逻辑：
1. 调用 `vscode.provideDocumentSemanticTokensLegend(uri)` 获取 legend
2. 调用 `vscode.provideDocumentSemanticTokens(uri)` 获取 tokens
3. 在 `legend.tokenTypes` 中找 `'comment'` 索引
4. 解码 delta 数组（每 5 个整数一组：deltaLine, deltaStartChar, length, tokenType, tokenModifiers）
5. 累加得到绝对位置，检查引用是否落在 comment token 范围内

降级策略：Semantic Tokens 不可用时跳过注释分类。

### Step 6 — 分类协调器 + 缓存

**新建文件：**
- `src/core/ReferenceClassifier.ts` — 协调所有 analyzer

```typescript
async classify(uri, position): Promise<ClassifiedReference[]> {
  // 1. 并行获取原始数据
  const [refs, defs, impls] = await Promise.all([
    executeReferenceProvider, executeDefinitionProvider, executeImplementationProvider
  ]);
  // 2. 去重 & 初始分类（definition/implementation/reference）
  // 3. 并行增强分类（读/写 + 注释 + 测试文件）
  // 4. 读取每个引用所在行的代码内容
}
```

- `src/core/Cache.ts` — LRU 缓存，key = `uri + position`，文件保存事件触发失效

### Step 7 — CodeLens

**新建文件：**
- `src/providers/ReferenceLensProvider.ts`

在函数/类/接口定义上方显示：
```
12 references (8 calls · 3 tests · 1 comment)  ← 点击触发 Find Smart References
```

- `provideCodeLenses`: 用 `executeDocumentSymbolProvider` 获取符号列表，为每个函数/类/接口创建 CodeLens
- CodeLens 引用计数使用轻量查询（只调 `executeReferenceProvider` 获取数量），不做完整分类
- 通过 `smartReferences.enableCodeLens` 控制开关

### Step 8 — extension.ts 入口

- `src/extension.ts` — activate 中注册：
  1. `smartReferences.findReferences` 命令 → 获取光标位置 → ReferenceClassifier.classify → TreeView 刷新
  2. ReferenceTreeProvider 注册到 `smartReferencesTree` view
  3. ReferenceLensProvider 注册（如果启用）
  4. Cache 的文件保存失效监听

### Step 9 — 树结构重构：分类 → 文件 → 函数 层次 ✅ 已完成

**需求变更：** 原 Step 2 的树结构（Category → Context → Item）不够直观，改为更贴近 IntelliJ "Find Usages" 的层次结构。

**新树结构：**
```
symbolName (N usages)
├── Definitions (1)
│   └── server.go
│       └── :142  func ServeHTTP(...)  [def]
├── References (6)
│   ├── router/mux.go
│   │   └── Dispatch (2)
│   │       ├── :34  h.ServeHTTP(w, r)  [read]
│   │       └── :88  h.ServeHTTP(w, r)  [write]
│   └── config/setup.go
│       └── :15  mux.Handler = h  [write]
├── Tests (2)
│   └── server_test.go
│       └── TestServe (2)
│           └── :77  h.ServeHTTP(rr, req)  [read]
└── Comments (1)
    └── doc.go
        └── :5  // ServeHTTP implements...
```

**顶层五大分类：**
- Definitions — `category === Definition`
- Implementations — `category === Implementation`
- References — `ReadAccess | WriteAccess` 且 `context === Production`
- Tests — `ReadAccess | WriteAccess` 且 `context === Test`
- Comments — `category === Comment`

**文件内按调用方函数分组：**
- 通过 `vscode.executeDocumentSymbolProvider` 查找每个引用所在的最内层函数/方法
- 存储在 `ClassifiedReference.containingSymbol` 字段
- 同文件只有一个无名函数分组时跳过 CallerNode 层级

**新增文件：**
- `src/core/concurrent.ts` — 并发控制工具（限制 LSP 请求并发数为 8）

### Step 10 — 引用预览面板 + 符号高亮 ✅ 已完成

**需求变更：** 对标 IntelliJ 的 Preview 面板，点击引用时右侧打开文件并高亮定位。

**实现：**

1. **符号高亮（TreeItemLabel.highlights）**
   - `ReferenceItem.label` 使用 `vscode.TreeItemLabel` 而非纯字符串
   - 根据 `ref.location.range` 计算符号在行文本中的字符范围
   - 调整 trim 偏移后传入 `highlights: [[start, end]]`
   - VSCode 用加粗/高亮渲染对应的字符区间

2. **上下文预览（contextLines）**
   - `ClassifiedReference` 新增 `contextLines: { before: string[]; after: string[] }`
   - `loadLineTexts` 同时加载引用行上 2 行、下 4 行
   - Tooltip 使用 MarkdownString + code block 显示上下文，引用行标记 `→`

3. **右侧预览面板（ReferencePreviewManager）**
   - 新增 `src/providers/ReferencePreviewManager.ts`
   - 新增命令 `smartReferences.previewReference`
   - 点击引用 → `vscode.window.showTextDocument` 在 `ViewColumn.Beside` 打开
   - `preserveFocus: true` 保持树视图焦点
   - `TextEditorDecorationType` 持久化高亮引用行（黄色背景 + overview ruler）
   - 切换引用时自动清除旧高亮

### Step 11 — Code Review 修复 ✅ 已完成

Code Review 发现并修复的问题：

| 文件 | 问题 | 修复 |
|------|------|------|
| `DefinitionAnalyzer.ts` | `executeDefinitionProvider` 无降级处理 | 加 `.then(r => r, () => [])` |
| `ReferenceClassifier.ts` | 同步 forEach 包在 Promise.resolve，有竞态风险 | 移到 Promise.all 之前同步执行 |
| `ReferenceLensProvider.ts` | `lens.command!` 非空断言无 guard | 改为 `if (!lens.command?.arguments) return lens` |
| `ReferenceTreeProvider.ts` | EventEmitter 未 dispose | 实现 `Disposable`，注册到 subscriptions |
| `ReferenceClassifier.ts` | `loadContainingSymbols` 无并发限制 | 引入 `runConcurrent` 限制 8 路 |
| `HighlightAnalyzer.ts` | 无并发限制 | 同上 |
| `SemanticTokenAnalyzer.ts` | 无并发限制 | 同上 |
| `Cache.ts` | 无缓存上限 | FIFO 上限 500 条 |
| `ReferenceClassifier.ts` | 无引用时 symbolName 为空 | 提前读取 word |

## 多语言支持策略

| 能力 | 依赖 | 语言覆盖 |
|------|------|---------|
| 引用查找 | `executeReferenceProvider` | 所有有 LSP 的语言 |
| 定义/实现 | `executeDefinition/ImplementationProvider` | 大多数 LSP |
| 读/写分类 | `executeDocumentHighlights` | gopls, tsserver, rust-analyzer, clangd 等 |
| 注释检测 | `provideDocumentSemanticTokens` | 支持 semantic tokens 的 LSP |
| 测试文件 | glob 模式匹配 | 通过配置覆盖所有语言 |

不支持某个能力时自动降级（不显示该分类），不会报错。

## 验证方式

1. `npm run compile` 编译通过
2. `npm test` 36/36 通过
3. F5 启动 Extension Development Host
4. 打开一个 Go/TS/Python 项目，右键符号 → "Find Smart References"
5. 验证侧边栏树结构：Definitions / Implementations / References / Tests / Comments
6. 验证各分类下按 文件 → 调用方函数 → 引用行 分层
7. 验证引用行中**符号文字高亮**（加粗/颜色标出）
8. 验证悬停 tooltip 显示上 2 行下 4 行上下文代码
9. 验证**点击引用**：右侧面板打开文件、高亮引用行、保持树焦点
10. 验证切换引用时旧高亮自动清除
11. 验证 CodeLens 在函数定义上方显示引用计数
