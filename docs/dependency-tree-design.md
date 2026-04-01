# 依赖树视图 + 依赖符号搜索 实施计划

## Context

新增两个功能：
1. 侧边栏新增 **"Dependencies"** 面板，展示项目依赖列表及各依赖的源码文件树
2. 快捷键 `Shift+Ctrl+Alt+T` 在 **依赖包中搜索符号**（LSP workspace/symbol 默认不索引依赖源码）

**扩展性要求**：架构需支持多语言，当前只实现 Go（go.mod + GOMODCACHE），后续可直接扩展 npm（package.json + node_modules）、Cargo（Cargo.toml）等，无需改动 TreeView 层。

---

## 功能一：依赖树面板

### 架构：Resolver 抽象 + 通用 TreeView

```
DependencyTreeProvider (通用 TreeView，不感知具体语言)
    │
    ├─ DependencyResolver (接口，每种语言一个实现)
    │     ├─ GoModResolver       ← 当前实现
    │     ├─ NpmResolver         ← 未来扩展
    │     └─ CargoResolver       ← 未来扩展
    │
    ├─ DependencyNode (一级节点：模块名 + 版本)
    └─ FileEntryNode  (二级及以下：文件/目录，懒加载)
```

### DependencyResolver 接口

文件：`src/core/DependencyResolver.ts`

```typescript
export interface ResolvedDependency {
  name: string;          // "github.com/some/module" / "lodash"
  version: string;       // "v1.2.3" / "4.17.21"
  localDir?: string;     // 本地缓存路径，undefined = 未下载
  indirect?: boolean;    // 间接依赖标记
}

export interface DependencyResolver {
  /** 检测当前 workspace 是否适用此 resolver */
  detect(): Promise<boolean>;
  /** 解析依赖列表 */
  resolve(): Promise<ResolvedDependency[]>;
  /** 监听依赖文件变化的 glob pattern */
  watchPattern: string;
}
```

扩展新语言只需：实现 `DependencyResolver` 接口 → 在 `extension.ts` 中注册到 resolvers 数组。

### GoModResolver 实现

同文件 `src/core/DependencyResolver.ts` 内导出。复用 GoModLinkProvider 中已验证的逻辑：
- go.mod 解析 regex（require block + 单行 require）
- `go env GOMODCACHE` + fallback `~/go/pkg/mod`
- 大写字母 `!lowercase` 路径编码
- `watchPattern = '**/go.mod'`

### DependencyTreeProvider

文件：`src/providers/DependencyTreeProvider.ts`

```
constructor(resolvers: DependencyResolver[])

refresh()
  → 遍历 resolvers，用第一个 detect()=true 的
  → resolver.resolve() → ResolvedDependency[]
  → fire(_onDidChangeTreeData)

getChildren(element?)
  !element            → DependencyNode[]（按 name 排序）
  DependencyNode      → FileEntryNode[]（readdir localDir）
  FileEntryNode(dir)  → FileEntryNode[]（readdir fsPath，懒加载）
  FileEntryNode(file) → []
```

节点行为：
- **DependencyNode**：`localDir` 存在 → Collapsed，图标 `$(package)`；不存在 → None（不可展开），描述 `(not downloaded)`
- **FileEntryNode**：目录在前、文件在后；隐藏 `.` 开头的条目；点击文件 → 编辑器打开

### extension.ts 注册

```typescript
const depProvider = new DependencyTreeProvider([new GoModResolver()]);
const depTreeView = vscode.window.createTreeView('dependencyTree', {
  treeDataProvider: depProvider, showCollapseAll: true,
});

// 自动监听依赖文件变化
for (const r of [goModResolver]) {
  vscode.workspace.createFileSystemWatcher(r.watchPattern)
    .onDidChange(() => depProvider.refresh());
}

// Refresh 命令
vscode.commands.registerCommand('smartReferences.refreshDeps', () => depProvider.refresh());
```

### package.json 改动

```jsonc
// contributes.views.smartReferences 追加：
{ "id": "dependencyTree", "name": "Dependencies" }

// contributes.viewsWelcome 追加：
{ "view": "dependencyTree", "contents": "No dependency file found in workspace." }

// contributes.commands 追加：
{ "command": "smartReferences.refreshDeps", "title": "Refresh Dependencies", "icon": "$(refresh)" }

// contributes.menus."view/title" 追加：
{ "command": "smartReferences.refreshDeps", "when": "view == dependencyTree", "group": "navigation" }
```

---

## 功能二：依赖符号搜索（Shift+Ctrl+Alt+T）

### 需求

- 快捷键 `Shift+Ctrl+Alt+T` 打开搜索框
- 搜索范围：所有 go.mod 依赖在 GOMODCACHE 中的源码
- **只搜索**：函数/方法、类型（struct/class）、接口
- **不搜索**：变量、常量、枚举

### 方案：正则预索引 + QuickPick 搜索

#### GoDepSymbolIndexer

文件：`src/core/GoDepSymbolIndexer.ts`

用正则扫描 `.go` 文件提取导出声明（比 `executeDocumentSymbolProvider` 快几个数量级）。

**扫描的声明类型**（仅大写字母开头 = Go 导出符号）：

| 正则 | 提取目标 | SymbolKind |
|---|---|---|
| `^func\s+([A-Z]\w*)\s*\(` | 包级函数 | Function |
| `^func\s+\([^)]+\)\s+([A-Z]\w*)\s*\(` | 方法（有 receiver） | Method |
| `^type\s+([A-Z]\w*)\s+struct\b` | struct 类型 | Struct |
| `^type\s+([A-Z]\w*)\s+interface\b` | 接口 | Interface |

**索引流程**：
```
buildIndex()
  → 解析 go.mod → 遍历每个依赖在 GOMODCACHE 的目录
  → 递归找 .go 文件（排除 _test.go、vendor/、testdata/）
  → 正则逐行匹配 → 生成 vscode.SymbolInformation[]
      uri = 文件 URI
      range = 匹配行的 Position
      kind = Function / Method / Struct / Interface
      containerName = package name（从文件首行 `package xxx` 提取）
  → 缓存到 Map<string, SymbolInformation[]>（key = modulePath@version）
```

**缓存策略**：
- 首次触发搜索时构建（QuickPick 显示 busy）
- go.mod 变化时标记失效，下次搜索重建
- 内存中保留，扩展 deactivate 时释放

#### 搜索流程

```
Shift+Ctrl+Alt+T
  → SymbolSearchProvider.showDepSymbolSearch()
  → 打开 QuickPick（title="Search Dependency Symbols"）
  → 如果索引未构建 → busy=true → buildIndex() → busy=false
  → onQueryChanged(query):
      从缓存中取全量 SymbolInformation[]
      ranker.rank(query, symbols, contextUri, 80,
        [Function, Class, Interface],   // filterCategories：不含 Variable/Enum
        ['.go'],                        // mainLangExts
      )
      buildItems(ranked) → 渲染到 QuickPick
  → onAccepted：在编辑器打开 GOMODCACHE 源文件并跳转到对应行
```

#### QuickPick UI

- title: `Search Dependency Symbols`
- placeholder: `Type to search functions, types, and interfaces in dependencies`
- 分类分隔符：`Functions & Methods` / `Classes` / `Interfaces`

### 改动文件

| 文件 | 操作 |
|---|---|
| `src/core/GoDepSymbolIndexer.ts` | **新增**：正则索引器 + 缓存 |
| `src/providers/SymbolSearchProvider.ts` | 新增 `showDepSymbolSearch()` 方法 |
| `src/extension.ts` | 注册命令 `smartReferences.searchDependencySymbols` |
| `package.json` | 新增命令 + `Shift+Ctrl+Alt+T` 快捷键 |

### package.json 改动

```jsonc
// contributes.commands 追加：
{
  "command": "smartReferences.searchDependencySymbols",
  "title": "Search Dependency Symbols",
  "icon": "$(search)"
}

// contributes.keybindings 追加：
{
  "command": "smartReferences.searchDependencySymbols",
  "key": "shift+ctrl+alt+t"
}
```

---

## 全部改动文件汇总

| 文件 | 操作 | 功能 |
|---|---|---|
| `src/core/DependencyResolver.ts` | **新增** | 接口 + GoModResolver |
| `src/providers/DependencyTreeProvider.ts` | **新增** | 通用依赖树 TreeDataProvider |
| `src/core/GoDepSymbolIndexer.ts` | **新增** | 依赖包正则符号索引 |
| `src/providers/SymbolSearchProvider.ts` | 修改 | 新增 `showDepSymbolSearch()` |
| `src/extension.ts` | 修改 | 注册所有新 provider/command/watcher |
| `package.json` | 修改 | view、commands、keybinding、menu |

---

## 验证

### 功能一：依赖树
1. `npx tsc -p ./` 编译通过
2. Reload Extension Host
3. 侧边栏 SmartReferences 出现 "Dependencies" 面板
4. 展开有缓存的依赖 → 显示 .go 文件树；点击文件 → 编辑器打开
5. 无缓存的依赖显示 `(not downloaded)` 不可展开
6. 点击 Refresh 按钮 → 重新解析 go.mod

### 功能二：依赖符号搜索
7. `Shift+Ctrl+Alt+T` → 打开搜索框，title 显示 "Search Dependency Symbols"
8. 首次搜索显示 busy → 索引构建完成后正常搜索
9. 输入 "Handler" → 显示依赖中包含 Handler 的函数/类型/接口
10. 不出现变量/常量符号
11. 选中结果 → 在编辑器打开 GOMODCACHE 中的源文件并跳转到定义行
