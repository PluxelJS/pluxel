# HMR / Loader / Core 插件系统设计说明（面向 LLM）

这份文档说明 `@pluxel/hmr` 如何与 `@pluxel/core` 的插件系统/DI（diod）协作：
- 插件的注册、依赖解析、commit 语义（含失败/回滚边界）
- HMR 的“批量执行 + 批量注入 + 单次 commit”如何保持一致性与性能
- Loader 侧如何处理“依赖 ctor 引用失配”（Vite HMR 热更最常见问题）

## 1) Core 插件系统（@pluxel/core）核心语义

### 1.1 标识与注入（性能优先、强约定）
- **插件实例的 DI key 永远是 ctor 本身**（包括 fork ctor）。不要“猜 token”，直接传你要的那个 ctor/base token。
- **抽象 base / interface token 的注入**通过 DI alias 实现：`@Plugin(Base)` 的实现类可以选择 `provideBase`，从而让 `Base` token 指向它。
- **冲突语义（确定性）**：同一个 base token 出现多个 provider 时，冲突在 build/commit（DI 验证）阶段被检测并报错；不是在 `registerPlugin()` 时“隐式覆盖”。

相关实现入口：
- `packages/core/src/plugins/runtime/PluginDefinitions.ts`：声明层（register/unregister/build）。
- `packages/core/src/plugins/runtime/PluginService.ts`：`commit()` 负责构建新容器、拓扑启动、失败收集与重试。

### 1.2 Commit 语义（非事务化启动，但 build 可回滚）
- commit 分为两段：
  - **build/verify 阶段（事务化）**：DI 构建/验证失败（缺依赖、alias 冲突等）→ 本次变更无效，容器不切换。
  - **lifecycle 启动阶段（非事务化）**：容器已经切换，部分插件 `init/start` 失败不会回滚整个 commit；失败插件会被记录并在后续 commit 自动重试（只要仍注册在容器里）。
- 失败插件从 `singletons` 缓存清理，确保下次 commit 会重新创建实例（而不是复用坏状态）。

### 1.3 草稿回滚：为什么需要 `resetDraft()`
HMR/Loader 会在 commit 前进行大量“声明层变更”（register/unregister/reload）。当 build/verify 失败时必须撤销这些草稿变更，否则后续 commit 会带着“脏草稿”继续滚动，导致难以定位问题。

因此 core 提供：
- `ctx.registry.resetDraft()`：回滚 DI builder 的草稿注册（buildables）。

> 注意：这不是“回滚到旧版本插件继续运行”，而是“回滚到上一次 confirm 后的草稿基线”。

## 2) HMR 总流程（@pluxel/hmr）

### 2.1 为什么需要依赖重绑（ctor 引用失配）
diod 默认按“构造函数引用”做依赖键：引用不一致即视为缺失。Vite HMR 会重新执行模块并生成新 ctor，但不会自动替换容器里依赖者的构造参数 token，因此会出现 MissingDependency（依赖者仍持有旧 ctor 引用）。

### 2.2 关键策略一：热更后重绑依赖者（最小成本）
在 `LoaderService.replaceModule` 之后执行 `refreshDependents()`：
- 记录旧模块导出的插件 ctor（oldItems）。
- 利用 `pluginInfo.id -> current ctor` 映射，把“直接依赖者”的构造参数 token 中的旧 ctor 替换成当前主 ctor。
- 仅处理 `BasePlugin` 子类 token；其他参数不动。

性能取舍：
 - 只触碰“受影响插件的直接 dependents”，依赖图来自 `ctx.registry.container?.dependents`，不会全量扫描所有插件。

### 2.3 关键策略二：批量注入事务（避免 loader/core 状态漂移）
`HMRService.runAndLoadAll()` 是“逐入口 evaluate + 注入（replaceModule）+ 单次 commit”：
- 为了性能与时序稳定：入口顺序执行；最终只 commit 一次。
- 但这意味着：如果 commit 在 DI build/verify 阶段失败，core 容器不会切换；若 loader 已更新自己的“声明层”映射，就会出现漂移（loader 以为插件已加载/重命名/锚定，core 实际未采纳）。

因此 `LoaderService.beginBatch()` 提供 **loader 声明层事务**：
- batch 内多次 `replaceModule()` 会记录 module/name 映射的旧值（O(变更)）。
- commit 成功：`batch.commit()` 固化这些声明层变更。
- commit 失败（仅 build/verify）：`batch.rollback()` 回滚声明层；同时调用 `ctx.registry.resetDraft()` 回滚 core 的 DI 草稿。

失败边界（这是预期行为）：
- **DI build/verify 失败**：回滚（因为容器没切换，本次变更“无效”）。
- **插件生命周期启动失败**：不回滚（容器已切换，属于非事务化 commit 的部分失败），插件作者会立即得到失败反馈；后续 commit 会自动重试。

### 2.4 Builtins：不经扫描即可预载/默认启用的插件
有些插件并不来自 HMR 扫描目录（例如你希望在 `new Context()` 时“引用 ctor 即可默认启用”的插件），但仍希望它们参与 HMR 的基线容器与启用位。

实现方式：
- `hmrService.builtins` 接受插件 ctor 列表（或带选项的对象），会在冷启动扫描前执行 `declare + enable + commit`，作为 baseline 容器；
- 这样后续 HMR 批量注入如果发生 **DI build/verify 失败回滚**，也会回滚到“包含 builtins 的 baseline 容器”，不会把 builtins 一起丢掉。

使用方式（推荐：宿主显式 import ctor，类型/跳转都更友好）：
```ts
import { Context } from '@pluxel/hmr'
import GraphQL from '@pluxel/graphql'
import Wretch from '@pluxel/wretch'
import { MarketUI } from 'pluxel-plugin-market-ui'

const ctx = new Context({
  hmrService: {
    builtins: [
      GraphQL,
      MarketUI,
      { plugin: Wretch, forks: ['prod', { id: 'staging', enable: false }] },
    ],
  },
})
```

Fork 支持：
- Forkable 插件（继承 `ForkablePlugin`）可以作为 builtin；
- 可在 builtin 配置里直接声明 `forks`，并选择是否启用某些 fork。

## 3) Optional / 动态导入与 HMR
`@pluxel/core` 的 `optional()` 设计目标是：可选依赖永远不阻塞构造；在 commit 之后如果依赖变为可用可以执行回调。

常见日志：
- `optional(dynamic import) 未在容器中`：动态导入拿到的 plugin ctor 尚未注册进容器（或正在 commit 的草稿容器中）。

为避免 commit 期间误报，core optional 会优先查看“active draft container”（commit 尚未 confirm 时）。

## 4) 文件/入口索引（给 LLM 的导航）
- HMR 批量执行入口：`packages/hmr/src/services/hmr/HMRService.ts`（`runAndLoadAll()`）
- Loader 注入与 dependents 重绑：`packages/hmr/src/services/loader/LoaderService.ts`
- Loader 声明层与 config/runtime 协调：`packages/hmr/src/services/loader/PluginRegistry.ts`
- Core 插件容器与草稿/确认：`packages/core/src/plugins/runtime/PluginDefinitions.ts`
- Core commit 编排与失败语义：`packages/core/src/plugins/runtime/PluginService.ts`

## 5) 注意事项（避免误解）
- “回滚”只针对 **DI build/verify 失败**（本次容器未切换）。生命周期失败不会回滚，这是刻意的：你需要看到即时失败与依赖链影响。
- 依赖重绑只处理“直接 dependents”，如果你引入了自定义 token/非 BasePlugin 的构造参数依赖，需自行保证 token 稳定或扩展重绑策略。
