# Project Layout 生成文件展示设计

## 背景

当前 `Project Layout` 会把文件分到：

- `Tests`
- `Modules`
- `Headers`
- `Generated`
- `Build`
- `Third-Party`

这套分组对规则实现比较直接，但对实际使用并不理想。`Generated` 把协议生成物、代码生成物单独抽成一个顶层分组后，目录树会被人为拆散：

- 使用者需要在 `Modules` 和 `Generated` 之间来回切换
- 同一个模块的手写文件和生成文件被拆到两个入口，不利于按模块浏览
- `Generated` 的语义重点其实不是“它属于另一个功能域”，而是“它不是主要编辑对象”

因此这次调整的目标不是隐藏生成文件，也不是把它们当成 `.gitignore` 文件处理，而是保留其原始归属，只降低视觉权重。

## 目标

1. 取消 `Generated` 顶层分组。
2. 生成文件仍然保留在 `Project Files` 中，不隐藏、不移入 `Ignored`。
3. 生成文件继续按工程语义并入正常分组：
   - 生成头文件进入 `Headers`
   - 生成源码和其他生成物进入 `Modules`
4. 生成文件在树上使用与 `.gitignore` 内文件一致的弱化样式，表达“可见但低优先级”。
5. 现有 `Build`、`Tests`、`Third-Party` 的优先级不变，避免破坏工程文件和测试文件的可预期归类。

## 非目标

1. 不隐藏生成文件。
2. 不把生成文件并入 `Ignored` 语义分组。
3. 不修改 `.gitignore` 判定本身。
4. 不在这一轮引入新的顶层分类。
5. 不改变 `Merged Tree` 与 `Sources / Tests` 的既有信息结构，生成文件弱化样式只在需要表达“工程语义但次要编辑对象”时启用。

## 设计原则

### 1. 先保留工程归属，再表达视觉降权

生成文件首先是模块的一部分，其次才是“生成物”。

因此分类顺序应当是：

- 先判断它属于 `Build` / `Tests` / `Third-Party` / `Headers` / `Modules` 中哪一类
- 再额外附加“generated-like”展示属性

也就是说，“生成文件”应该是一个展示属性，而不是独立分类。

### 2. 生成属性不应打断目录连续性

如果 `foo/` 目录下同时存在：

- `user_service.cpp`
- `user_service.pb.cpp`
- `user_service.pb.h`

那么使用者在浏览时更需要看到它们仍然挂在同一条模块路径下，而不是被 `Generated` 顶层分类拆走。

### 3. C/C++ 测试优先仍然成立

用户此前已明确要求优先处理 C/C++ 测试，因此当某个文件同时命中“测试”与“生成”时，应先归入 `Tests`，再决定是否附加弱化样式。

例如：

- `tests/generated/foo.pb.cpp`
- `test/bar_mock.pb.h`

这类文件应先出现在 `Tests` 分组下，而不是因为“generated”被分流。

## 目标行为

`Project Layout` 顶层分类调整为：

- `Tests`
- `Modules`
- `Headers`
- `Build`
- `Third-Party`

### 分类规则

#### Build

优先识别工程文件和构建入口，例如：

- `CMakeLists.txt`
- `Makefile`
- `*.mk`
- `*.sln`
- `*.vcxproj`
- `*.csproj`
- `Package.swift`
- `Cargo.toml`
- `build.gradle`
- `build.gradle.kts`
- `*.xcodeproj`
- `*.xcworkspace`

#### Third-Party

优先识别第三方依赖和 vendored 代码，例如：

- `third_party/`
- `vendor/`
- `external/`
- 常见第三方库目录名

#### Tests

优先识别测试目录和测试命名约定，尤其是 C/C++ / Objective-C：

- `test/`
- `tests/`
- `*_test.*`
- `*.test.*`
- `*.spec.*`
- `*_unittest.*`
- 以及其他已支持语言的默认测试规则

#### Headers

头文件统一进入 `Headers`，包括生成头文件，例如：

- `include/foo/bar.h`
- `proto/user.pb.h`
- `generated/model.g.hpp`

#### Modules

除上述情况外的源码文件和普通模块文件统一进入 `Modules`，包括生成源码，例如：

- `src/service/user_service.cpp`
- `proto/user.pb.cpp`
- `generated/schema.rs`
- `build/gen/Foo.swift`

其中 `Build` 的判定仍应先于 `Modules`，避免工程入口文件被错误落到模块组。

## 生成文件的展示规则

### 视觉效果

生成文件不再单独成组，而是复用当前 `.gitignore` 内文件的弱化展示样式：

- 使用与 ignored file 相同的 `disabledForeground` 风格
- 保持可点击、可 reveal、可打开
- 不修改其 tooltip、真实路径或 tree path

### 语义边界

这里复用的是“样式”，不是“分组语义”：

- 它不是 ignored file
- 不进入 ignored 目录树
- 不参与 ignored 专属逻辑
- 只是共享一套降权视觉表达

## 实现思路

### 1. 分类层去掉 `Generated`

`ProjectExplorerGrouping` 不再返回 `cppGenerated`。原先的生成规则保留，但只作为附加属性使用。

建议改成两步：

1. `classifyCppProjectPath(relativePath, isTest)` 只负责返回最终分组：
   - `cppTests`
   - `cppModules`
   - `cppIncludes`
   - `cppBuild`
   - `cppThirdParty`
2. 另行提供 `isGeneratedProjectPath(relativePath)`，用于树节点展示层决定是否弱化显示。

### 2. 展示层新增“弱化文件”能力

`ProjectExplorerProvider` 需要把“测试文件弱化”和“生成文件弱化”抽成统一能力，而不是只绑定到测试 scheme。

建议方向：

- 保留真实文件 URI 解析逻辑
- 将弱化展示抽象为通用 dimmed scheme 或 dimmed state
- 测试文件和生成文件共用同一套 decoration provider

这样可以避免未来继续为每一种弱化文件再加一套专用 scheme。

### 3. 生成头文件与生成源码的归属

生成文件不再独立成组后，默认归属如下：

- `*.pb.h`、`*.g.h`、`*_generated.hpp` 等生成头文件进入 `Headers`
- `*.pb.cc`、`*.pb.cpp`、`*.g.cpp`、`*_generated.rs` 等生成源码进入 `Modules`

也就是说，生成属性不会覆盖“头文件 vs 源码”这一层工程语义。

### 4. 优先级顺序

建议判定顺序保持为：

1. `Third-Party`
2. `Build`
3. `Tests`
4. `Headers`
5. `Modules`

“是否生成文件”不再作为决定顶层类别的分支，而是作为补充属性在分类完成后计算。

## 测试策略

### 逻辑测试

需要覆盖这些场景：

- 生成头文件进入 `Headers`
- 生成源码进入 `Modules`
- 普通头文件仍进入 `Headers`
- 普通源码仍进入 `Modules`
- `tests/generated/foo.pb.cpp` 仍优先进入 `Tests`
- 第三方目录下的生成文件仍优先进入 `Third-Party`
- 构建目录或工程入口文件仍优先进入 `Build`
- Windows `\` 路径、WSL 混合路径、重复分隔符路径都能稳定命中生成规则

### 展示测试

需要至少验证：

- 生成文件不再出现于独立 `Generated` 顶层节点
- 同目录下的手写文件与生成文件仍出现在同一分组树内
- 生成文件具有与 ignored file 一致的弱化样式
- 生成文件点击打开与 reveal 行为不受影响

## 兼容性说明

这次调整属于展示模型优化，不应改变文件是否可见，也不应改变文件点击后的真实定位路径。

对用户可见的核心变化只有两点：

1. `Generated` 顶层分类消失
2. 生成文件在 `Modules` / `Headers` 中以弱化样式出现

除此之外，`Project Layout` 的工程文件识别、测试优先级、第三方目录优先级都应保持稳定。
