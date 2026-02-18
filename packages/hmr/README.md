# HMR / Loader / Core 插件系统设计说明（面向 LLM）

这份文档说明 `@pluxel/hmr` 如何与 `@pluxel/core` 的插件系统/DI（diod）协作：
- 插件的注册、依赖解析、commit 语义（含失败/回滚边界）
- HMR 的“批量执行 + 批量注入 + 单次 commit”如何保持一致性与性能
- Loader 侧如何处理“依赖 ctor 引用失配”（Vite HMR 热更最常见问题）

## 0) 包边界（对外 only: core / hmr / cli）

对外（发布/建议依赖）的包只有三个：
- `@pluxel/core`
- `@pluxel/hmr`
- `@pluxel/cli`

仓库里的其他包（例如 `@pluxel/components`、`@pluxel/hmr-web`）都是内部实现：`private: true`，不保证 API 稳定。

为什么需要 `@pluxel/hmr-web`（internal）：
- `@pluxel/hmr` 需要 `@pluxel/components` 来构建/打包 HMR UI（Vite client bundle）。
- `@pluxel/components` 又需要浏览器侧的 RPC/SSE client + UI 插件 authoring API。
- 若 `components` 直接依赖 `hmr` 会产生 workspace 级双向依赖（build graph cycle）。
- 因此把浏览器 SDK 放在 `@pluxel/hmr-web`（internal, private）给内部宿主使用；对外通过 `@pluxel/hmr/web`（public 子路径导出）提供同等能力。
- UI 扩展的 RPC/SSE 命名空间类型以 `@pluxel/hmr/web` 作为 declaration merging 目标：
  - 源码实现仍在 internal `@pluxel/hmr-web`；
  - `@pluxel/hmr` build 时通过 tsdown `noExternal` vendor 进 `@pluxel/hmr/web`，并在生成 `.d.ts` 时自动重写模块名，保证发布物不泄露 `@pluxel/hmr-web`。

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

常见坑（pnpm workspace / 扫描 roots 设为工作区根目录时）：
- `builtins` 会以合成 moduleId（例如 `"pluxel:builtins"`）建立 baseline；如果同一插件源码又被按文件路径扫描执行，可能触发插件名冲突或双注册。
- 处理方式二选一即可：
  - 想让插件走扫描/HMR：把它从 `builtins` 移除；
  - 想让插件只作为 builtin：用 `hmrService.exclude` 把该插件源码目录排除出扫描范围（注意：`deps.bridgeModules` 仅影响按 specifier 导入的单例，不会阻止按路径扫描）。
  ```ts
  hmrService: {
    roots: ['.'],
    builtins: [GraphQL],
    exclude: ['packages/plugins/graphql/**'],
  }
  ```

## 3) Optional / 动态导入与 HMR
`@pluxel/core` 的 `optional()` 设计目标是：可选依赖永远不阻塞构造；在 commit 之后如果依赖变为可用可以执行回调。

常见日志：
- `optional(dynamic import) 未在容器中`：动态导入拿到的 plugin ctor 尚未注册进容器（或正在 commit 的草稿容器中）。

为避免 commit 期间误报，core optional 会优先查看“active draft container”（commit 尚未 confirm 时）。

## 4) 文件/入口索引（给 LLM 的导航）
- HMR 批量执行入口：`packages/hmr/src/services/runtime/hmr/HMRService.ts`（`runAndLoadAll()`）
- Loader 注入与 dependents 重绑：`packages/hmr/src/services/runtime/loader/LoaderService.ts`
- Loader 声明层与 config/runtime 协调：`packages/hmr/src/services/runtime/loader/PluginRegistry.ts`
- Core 插件容器与草稿/确认：`packages/core/src/plugins/runtime/PluginDefinitions.ts`
- Core commit 编排与失败语义：`packages/core/src/plugins/runtime/PluginService.ts`

## 5) 注意事项（避免误解）
- “回滚”只针对 **DI build/verify 失败**（本次容器未切换）。生命周期失败不会回滚，这是刻意的：你需要看到即时失败与依赖链影响。
- 依赖重绑只处理“直接 dependents”，如果你引入了自定义 token/非 BasePlugin 的构造参数依赖，需自行保证 token 稳定或扩展重绑策略。

## 6) MCP（面向 code agent 的最小控制面）

Pluxel 的“内部 API”现在额外挂载了一个 MCP（Model Context Protocol）端点，用于让外部 agent 以**统一工具调用**的方式驱动插件开发闭环（无需再解析日志文本或自定义一套 RPC 协议）。

- 端点：`/api/mcp`（与 `/api/rpc` 同级，受 AuthGuard 的 `api` 守卫策略保护）
- Tool 子集（最小）：`hmr.waitForStable`（推荐）/ `hmr.waitForBatch`、`logs.latestText` / `logs.waitForText`（可选）`plugin.start` / `plugin.stop` / `plugin.restart`
- Logs “流式 tail”：MCP 侧提供 `logs.waitFor`（等待直到出现匹配日志或超时），可用于 agent 侧循环调用实现可靠的 tail/follow（无需额外 SSE 连接管理）。
- Logs “LLM 友善文本视图”：MCP 侧提供 `logs.latestText` / `logs.waitForText`（去噪 + 稳定截断 + 少字段），优先给 agent 使用。
- Dev loop 辅助：`plugins.list` / `plugin.status` / `plugin.waitForStage` / `plugin.schema` / `plugin.config.*` / `workspace.resolveEntry` / `workspace.listEntries` / `hmr.lastBatch` / `hmr.executeFiles`
- HMR 完成信号：由 `ctx.root.hmrService.api.waitForBatch()` / `waitForStable()` 提供（返回 batch 摘要；`ok` 表示 batch 成功与否，`lifecycleOk`/`commit.failed` 表示插件生命周期启动是否失败）

## 7) CLI：一次性 agent 入口（不常驻）

Pluxel 的 HMR host 默认是“常驻监听”（dev server + watcher）。对 code agent / CI 来说更需要“一次跑完就退出，并产出可读日志”。

`pluxel-hmr agent` 的默认策略是 **state-based**：
- `warmup()` 冷启动执行入口（注册/注入/commit）
- `waitForIdle()` drain 内部 batch 队列（不靠时间判断稳定）
- best-effort shutdown（带超时兜底，避免卡死）
- 导出 LLM 友好日志与结构化摘要

### 产物
- `logs/hmr.llm.txt`：LLM 友好精简日志（用于阅读/贴到 prompt）
- `logs/hmr.agent.summary.json`：结构化摘要（ok / errors / timedOut flags）
  - `ok=false` 当出现：`warmupError` / `agentError` / `idleTimedOut` / `stableTimedOut` / `shutdownTimedOut`

### 退出码
- `ok=true` → `0`；否则 `1`

### 常用命令
```bash
# 工作目录下使用（默认 root = cwd）
pluxel-hmr agent --clean --json

# 可选：如果你需要“安静窗口”语义（时间语义），再加 quiet-ms
pluxel-hmr agent --clean --json --quiet-ms 250

# 可选：重项目/慢环境可提高兜底超时（默认 10000ms）
pluxel-hmr agent --clean --json --timeout-ms 30000
```

### 注意：`--json` 输出是可机器解析的纯 JSON
agent 模式会抑制运行期间的 stdout 噪声（例如 Vite `printUrls()`），避免污染 JSON；详细信息看 `logs/*`。

如果你是通过 pnpm script 运行，为避免 pnpm 自己的脚本前缀污染 stdout，建议用：
- `pnpm -s exec pluxel-hmr agent --clean --json` 或
- `pnpm -s run hmr:agent`

另外，agent 模式默认把运行时 state（config/plugin-data）写到 `.pluxel/`，避免落到 git-tracked 的 `data/` 目录。

### 注意：本地开发（workspace link）需要更新 dist
`pluxel-hmr` bin 默认优先加载 `dist/cli.mjs`。如果你在 monorepo 里修改了 `src/cli.ts`，请先：
```bash
# 在 @pluxel/hmr 包目录执行（或从 repo root 用 -C 指向它）
pnpm build
# 或：pnpm -C packages/hmr build
```

也可以在安装了 bun 的情况下使用：
```bash
PLUXEL_HMR_CLI_SOURCE=1 pluxel-hmr agent --clean --json
```
