# Symbol Search 设计文档

## 概述

Symbol Search 提供两个针对性的符号检索入口，替代 VS Code 原生混乱的 `Ctrl+T`：

| 快捷键 | 命令 | 检索范围 |
|--------|------|----------|
| `Shift+Shift` | Search Symbol | 全部符号 |
| `Ctrl+Shift+N` | Search Function / Method | 函数、方法 |
| `Ctrl+Alt+T` | Search Type | 类、接口、枚举、结构体 |

---

## 架构

```
SymbolSearchProvider                ← 入口，管理 QuickPick 生命周期
    │
    ├─ detectMainWorkspaceLanguage()      ← 检测主语言
    │
    ├─ 当前文件是 .proto ?
    │    ├─ 否 → vscode.executeWorkspaceSymbolProvider(query)
    │    │        └─ 同时调用所有语言的 LSP workspace symbol provider
    │    └─ 是 → ProtoWorkspaceNavigator.searchSymbolsForQuery(query)
    │             ├─ ProtoSymbolMapper 识别 proto 符号语义
    │             ├─ 按主语言生成 query aliases
    │             └─ 依次调用 workspace symbol provider 搜索别名
    │
    ├─ SymbolRanker.rank()                ← 打分、去重、过滤
    │       ├─ 分类过滤（先于 maxResults 截断）
    │       ├─ 匹配分：exact > prefix > camelCase > includes > LSP trusted
    │       ├─ 支持 query aliases 参与匹配
    │       ├─ 主语言加分 (+600)
    │       └─ 测试文件惩罚 (-800)
    │
    └─ buildItems()                       ← 构建 QuickPick 列表
            ├─ 生产代码符号（各分类）
            └─ 测试代码符号（各分类，带 $(beaker) Tests 标记）
```

---

## 分类过滤

过滤在 `SymbolRanker.rank()` 内部、`maxResults` 截断之前执行。

**核心原因**：LSP 返回的原始符号中，Function 数量往往远多于 Type。若先截断再过滤，Type 符号会被 Function 挤出 top-N，导致类型检索中缺少 Struct/Class。

```
vscode.executeWorkspaceSymbolProvider("test") → 155 symbols
    ↓ category pre-filter (for type search)
  10 symbols (6 Python Class + 4 Go Struct)
    ↓ rank + score
  top 80 (all 10)
    ↓ buildItems
  QuickPick items
```

### SymbolKind → SymbolCategory 映射

| SymbolKind | SymbolCategory |
|------------|---------------|
| Class, Constructor, **Struct**, TypeParameter | Classes |
| Interface | Interfaces |
| Function, Method, **Operator** | Functions & Methods |
| Variable, Constant, Field, Property | Variables & Constants |
| Enum, EnumMember | Enums |
| 其余 | Other |

`Struct`、`Operator`、`TypeParameter` 为多语言补充（Go/Rust/C++ 等）。

---

## 评分系统

最终分 = matchScore + kindScore + pathScore + recentScore + proximityScore + langBoost + testPenalty − lengthPenalty

| 分项 | 值 | 说明 |
|------|-----|------|
| matchScore | 5000 / 4000 / 3000 / 2000 / 1000 | 精确 / 前缀 / CamelCase / 包含 / LSP trusted |
| kindScore | 500 / 400 / 200 / 100 | Class·Interface·Enum / Function / Variable / Other |
| pathScore | 300 / 0 | 非排除路径 / node_modules·vendor·dist 等 |
| recentScore | 0–800 | 最近访问记录，线性衰减，最多保留 50 条 |
| proximityScore | 200 / 100 / 0 | 同目录 / 同父目录 / 其他 |
| langBoost | +600 / 0 | 文件扩展名匹配主语言 |
| testPenalty | −800 / 0 | 文件匹配测试规则 |
| lengthPenalty | 0–100 | 符号名长度，防止长名字刷高分 |

**LSP trusted（matchScore=1000）**：`vscode.executeWorkspaceSymbolProvider` 已通过 LSP 自身的模糊算法过滤，对其返回的符号给予基础分而不是丢弃，保证多语言项目中 Go/Rust 等符号不被 Python 类的精确匹配排挤出去。

---

## 多语言支持

### 问题背景

`vscode.executeWorkspaceSymbolProvider(query)` 同时调用所有已激活语言的 LSP。在 Go + Python 混合项目中：
- gopls 返回 Go 符号
- Pylance 返回 Python 符号
- 两者结果合并后排序

若只依赖自定义名称匹配，不同语言 LSP 的模糊匹配策略不同，会导致部分语言的符号被过滤丢失。

### 主语言检测

在 `show()` 调用时，扫描 workspace 根目录特征文件，按优先级确定主语言：

| 特征文件 | 主语言 | 加分扩展名 |
|----------|--------|-----------|
| `go.mod` | Go | `.go` |
| `Cargo.toml` | Rust | `.rs` |
| `pom.xml` | Java | `.java` |
| `build.gradle` / `build.gradle.kts` | Java/Kotlin | `.java` `.kt` |
| `tsconfig.json` | TypeScript | `.ts` `.tsx` |
| `pyproject.toml` / `requirements.txt` / `setup.py` | Python | `.py` |
| `package.json` | JavaScript | `.js` `.jsx` |
| `*.sln` / `*.csproj` | C# | `.cs` |

### 去重

多个 LSP 可能对同一符号重复返回。`rank()` 内用 `name\0uri` 作 key 去重，`\0` 为分隔符（避免 `::` 在 C++/TypeScript namespace 名中产生歧义）。

---

## Protobuf 场景映射

### 目标

当用户位于 `*.proto` 文件中执行以下操作时：

- `Search Symbol`
- `Find Smart References`
- `Find Implementations`
- VS Code 原生 `Go to Definition / Find References / Go to Implementation`

不直接拿 `.proto` 中的原始名字去搜，而是先转换为当前项目主语言中更可能出现的目标符号，再执行现有工作区能力。

### 背景问题

`.proto` 中的名字与目标语言生成代码的命名往往不一致，例如：

| proto 名称 | Go | C# | Java / Kotlin / JS / TS | Python |
|-----------|----|----|--------------------------|--------|
| `user_profile` | `UserProfile` | `UserProfile` | `userProfile` / `getUserProfile()` | `user_profile` |
| `user_id` | `UserId` / `GetUserId()` | `UserId` | `userId` / `getUserId()` | `user_id` |

若直接执行 `workspace symbol("user_id")`，在 Go/C#/Java 项目里常常找不到真实目标。

### 统一方案

新增两层职责：

- `ProtoSymbolMapper`
  - 识别当前光标所在 proto 符号的语义种类：`type` / `field` / `callable` / `value`
  - 按目标语言生成别名集合（aliases）
- `ProtoWorkspaceNavigator`
  - 负责把 aliases 发给 `vscode.executeWorkspaceSymbolProvider`
  - 在查询构造阶段补包名候选，而不是只做结果排序
  - 过滤 `.proto` 自身结果，只保留主语言文件
  - 对符号结果重新评分，选出最强锚点
  - 再基于锚点继续执行 definition/reference/implementation
  - 同时补扫 `.proto` 文件内的文本引用，产出独立 `Proto` 分类

### 首批支持语言

当前只覆盖热门语言，并保留扩展能力：

| 语言 | 当前规则 |
|------|----------|
| Go | 字段/类型优先 `PascalCase`，字段补 `GetXxx` |
| C# | 字段/类型优先 `PascalCase`，枚举值支持去前缀后再转 `PascalCase` |
| Java | 字段优先 `camelCase`，补 `get/set/has/clear` 访问器 |
| Kotlin | 同 Java |
| JavaScript | 字段优先 `camelCase`，补 `get/set/has/clear` |
| TypeScript | 同 JavaScript |
| Python | 字段保持 `snake_case` |
| Rust | 保留 `snake_case`，并补 `PascalCase` 类型兜底 |

### 包感知查找

仅靠符号名在跨包同名场景下不够稳定，因此 `.proto` 查找会同时使用：

- `package`
- `go_package`
- `java_package`
- `csharp_namespace`
- 光标下符号自带的全限定包前缀

这些信息有两层用途：

1. 参与 `workspace symbol` 查询构造，例如同时尝试 `pkg.Symbol`、`pkg Symbol`
2. 参与候选结果评分，优先命中当前包/命名空间

目标是优先修正成功链路上的锚点选择，而不是依赖后续补偿过滤。

### Proto2 / Proto3 差异

这里按 protobuf 官方文档中的语法与 field presence 规则实现，而不是把两种语法混成一套。

#### 当前已纳入实现的差异

| 差异点 | proto2 | proto3 | 当前处理 |
|--------|--------|--------|----------|
| 字段标签 | `required/optional/repeated` | `optional/repeated`，未标注为 singular | 已解析 `fieldLabel` |
| field presence | singular 字段默认有 presence | 只有 `optional` 标量、message、oneof 等场景显式 presence | 已用于控制 `hasXxx` alias |
| oneof | 支持 | 支持 | `inOneof` 单独识别 |
| extensions / extend | 支持 | 不支持普通扩展字段 | 已补基础语法识别 |
| group | 支持但已废弃 | 不支持 | 已补基础语法识别 |
| 显式默认值 | 支持 `[default=...]` | 不支持字段默认值声明 | 当前不参与 alias，但已作为后续边界记录 |

#### 对 alias 生成的直接影响

当前不再无脑为所有 Java / Kotlin / JS / TS 字段补 `hasXxx`：

- `proto2` singular 字段：允许 presence 相关 alias
- `proto3 optional` 标量字段：允许
- `proto3 oneof` 字段：允许
- `proto3` message 类型字段：允许
- `proto3` 普通标量字段：不补 `hasXxx`

这样可以减少错误锚点，例如把 proto3 普通标量字段误搜成只存在于 proto2/runtime 的 presence API。

### Proto 引用分类

`Find Smart References` 在 `.proto` 场景下会产生两类结果：

- 映射后的目标语言代码引用
- `.proto` 文件内部的真实文本引用

其中 `.proto` 文件命中的位置会进入独立的 `Proto` 分类，而不是混入 `Read access / Write access`。

当前文本引用扫描策略：

- 同包内允许短名引用
- 跨包要求全限定名命中
- 会跳过当前光标所在 token

### 扩展方式

这里不使用“一套通用大小写转换规则”硬套所有语言，而是按语言分派规则：

- 语言检测在 `WorkspaceLanguageProfile`
- 规则生成在 `ProtoSymbolMapper`
- 导航编排在 `ProtoWorkspaceNavigator`

后续新增语言时，原则上只需要：

1. 在主语言检测中加入语言标识和扩展名
2. 在 `ProtoSymbolMapper` 增加该语言的 alias 规则
3. 复用现有导航链路，无需改 symbol search / reference / definition 主流程

### 非目标

当前不做插件级别的 protoc 生成器精确识别，例如：

- 不区分不同 JS/TS protobuf runtime 的细粒度差异
- 不区分所有 gRPC 框架对 `service/rpc` 的命名约定
- 不尝试从 `option` 或自定义插件配置中反推生成命名
- 不做完整 protobuf 语义解析器，只覆盖查找准确性最关键的语法差异

策略是先覆盖热门语言的主流生成结果，保证成功链路稳定，再按需要补具体语言/框架规则。

---

## 测试文件区分

### 规则来源

统一使用 `TestFileDetector`，读取 `smartReferences.testFilePatterns` 配置（glob 数组），开箱支持：

| 语言 | 规则示例 |
|------|----------|
| Go | `**/*_test.go` |
| TypeScript/JavaScript | `**/*.test.ts`, `**/*.spec.js`, `**/__tests__/**` |
| Python | `**/test_*.py`, `**/*_test.py`, `**/tests/**/*.py` |
| Java | `**/*Test.java` |
| Kotlin | `**/*Test.kt` |
| Rust | `**/tests/**/*.rs` |
| C# | `**/*Tests.cs`, `**/*.Tests/**` |

用户可通过配置项扩展规则，无需修改代码。

### 结果分组

`buildItems()` 将排序后的符号按测试/非测试拆分：

```
── Classes ───────────────────────────
  PaymentHandler    handler/payment.go:42
  OrderProcessor    handler/order.go:15

── Classes  $(beaker) Tests ──────────
  TestPaymentSuite  handler/payment_test.go:8
```

测试文件符号同时在 `rank()` 内受 −800 惩罚，确保同分类内非测试符号优先排序。

---

## 空状态（无输入时）

打开 QuickPick 未输入时，显示两组内容：

1. **Current File** — 当前文件的符号（通过 `vscode.executeDocumentSymbolProvider` 获取，按激活的分类过滤）
2. **Recent** — 最近访问的符号（最多 50 条，按 `recordAccess()` 调用顺序排列）

空状态同样遵守分类过滤，例如用 `Ctrl+Alt+T` 打开时只显示当前文件的类型符号。

---

## QuickPick 行为说明

所有结果项设置 `alwaysShow: true`，绕过 VS Code QuickPick 内置的 label 文本过滤。

**原因**：QuickPick 在设置 `items` 后会再次用当前输入文本过滤 label，与我们已经由 LSP + ranker 完成的过滤双重叠加，导致 LSP 模糊匹配到但名称不含查询词的符号（如 Go Struct 名不含 "test"）被 QuickPick 隐藏。

选中后跳转直接在当前编辑器执行，不触发分屏预览（与引用查找的 previewer 行为隔离）。
