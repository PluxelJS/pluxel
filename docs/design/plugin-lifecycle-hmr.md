# Plugin Lifecycle and HMR

本文梳理 Pluxel core / runtime / hmr 三层的插件启停逻辑，并判断当前 HMR 行为是否满足实用要求。

结论先行：

- core 的生命周期模型是可用的：启停顺序、失败隔离、依赖级联、重启语义都在 `PluginService` 中集中完成。
- runtime 把“声明层 / 配置启用位 / core 草稿”拆开后，适合承载 HMR、ops、UI control-plane 这些外部入口。
- HMR 对“改插件自身后默认重启”支持明确。
- HMR batch 现在会消费 runtime loader 给出的 DI 级联 affected modules；因此“依赖它的插件也跟着重启”不再只依赖 Vite moduleGraph。
- HMR summary 已暴露本次 batch 的 `affectedModules` / `syncedModules` / `autoDisabled` / `enabledButStopped`，并从 core commit summary 推导 `restarted`。
- 控制面语义已收敛：`enable` 表示“启用并立即启动”，`enable-persisted` 才表示“只写持久启用位”。
- 已评估同 id 单插件替换复用 core `replace()`：当前不采用，原因是 module-level HMR 需要稳定的 loader 查询语义和 rollback 边界。

## 分层

插件启停实际跨三层：

- `@pluxel/core`
  `packages/core/src/plugins/runtime/PluginService.ts`
  负责 DI graph、插件实例、`init()` / `stop()` / `effects.dispose()`、拓扑启停、失败传播。
- `@pluxel/runtime`
  `packages/runtime/src/services/runtime/loader/*`
  负责模块声明、插件名到 ctor 的映射、配置启用位、runtime ops、HMR 注入事务。
- `@pluxel/hmr`
  `packages/hmr/src/dev/hmr/*`
  负责 Vite watcher、moduleGraph、runner 重新执行、batch commit、缺依赖自动禁用与重试。

可以把它理解成：

- core 只知道“哪些 ctor 在 DI graph 中，哪些实例应该运行”。
- runtime 知道“哪个 module 提供哪些插件、哪些插件在配置中启用”。
- HMR 知道“哪个源码文件变了，以及应该重新执行哪些 anchor module”。

## Core 生命周期

core 的公共动作是 `register` / `unregister` / `replace` / `restart` / `commit`。

`register()` 和 `unregister()` 只改草稿图；真正启停发生在 `commit()`。`commit()` 会：

1. build / verify 新 DI graph。
2. 根据 delta 和 pending restart 计算 `toStop` / `toStart`。
3. 停旧实例：按 reverse topo 停，先停 dependents，再停 provider。
4. 删除需要重建的 runtime instances。
5. 启新实例：按 topo ready queue 启，依赖成功后 dependent 才会启动。
6. 发布 `CommitSummary`，包含 `added` / `replaced` / `removed` / `failed` / `touched`。

关键语义：

- `unregister(id)` 默认 `cascadeDependents: true`，会把依赖它的插件一起从草稿图移除。
- `restart(id)` 默认 `cascadeDependents: true`，会重启目标及其依赖者。
- `replace(target, next)` 默认 `cascadeDependents: true`，会把旧 token alias 到新 ctor，并重启影响子树。
- `cascadeDependents: false` 是显式逃生口；它会保留 dependent 实例，但使用者必须接受旧实例可能继续持有旧依赖。
- 启动失败不是全局事务失败。失败插件会被从 runtime cache 删除，dependent 会被标记失败；已经成功启动的其它插件保留。
- build / verify 失败是图构建失败，会回滚 draft。
- 停止是 best-effort，`stop()` 后仍会执行 `dispose()`，`effects` 是插件级清理的主要边界。

这部分整体符合实用要求：core 具有清晰的拓扑顺序、级联默认值和失败隔离。

## Runtime 启停入口

runtime 的 `PluginRegistry` 维护三类状态：

- module 声明：`moduleId -> [{ ctor, exportKey }]`
- 插件名映射：`name -> ctor`
- 配置启用位：`configService.isEnabledInConfig(name)`

runtime control-plane 的动作语义：

- `start`
  `control.enable(name, ctor)`：打开配置启用位，向 core 注册 ctor，最后统一 `commit()`。
- `stop`
  `deactivate(..., { runtimeOnly: true })`：从 core unregister，保留配置启用位，最后 `commit()`。
- `restart`
  当前实现是 `stop` 再 `start`，最后 `commit()`。
- `disable`
  runtime stop，并关闭配置启用位。
- `enable`
  与 `start` 一样，表示打开配置启用位并立即注册到 core。这个语义符合 UI switch / CLI 直觉。
- `enable-persisted`
  只打开配置启用位，不把插件注册进 core，也不会立即启动。用于低层工具需要“下次启动时启用”的场景。

`LoaderService.preloadPlugins()` 用于 builtins baseline。它会声明 builtin、按默认启用策略 seed 配置位并 commit。非 strict 模式下，如果 DI verify 报 `MissingDependency`，会自动把缺依赖链上已知的插件禁用，然后重试 commit，保证宿主仍能起来。

HMR 批处理用 `loader.beginBatch()` 包住 loader 声明状态。这个返回值是 runtime 明确导出的 `LoaderBatch` contract，而不是 HMR 侧的鸭子类型：

- `replaceModule(moduleId, mod): Promise<boolean>`
  替换一个已执行模块的声明和运行态，返回它是否仍是 plugin anchor。
- `listAffectedModules(): readonly string[]`
  返回本 batch 中 runtime 基于 core DI graph 收集到的 affected modules。
- batch 成功：`batch.commit()`
- batch 失败：`batch.rollback()` + `ctx.registry.resetDraft()`

这样 core 草稿和 loader 模块声明不会漂移。

## HMR 更新链路

HMR 启动后会：

1. attach 到已有 `Context`。
2. 启动 Vite dev server 和 SSR runner。
3. bridge host singleton modules，避免 core/runtime/context 被 runner 评估出第二份。
4. preload builtins baseline。
5. warmup 执行 `entries`，把插件 module 注册成 anchors。

文件变更后：

1. watcher 收到 `change` / `add` / `unlink`。
2. `enqueueFileChange()` 过滤 scope：
   - 在 watch roots / include 内；
   - 或已是 loader anchor；
   - 或已经在 Vite runner moduleGraph 中，即使不在初始 roots，也接受。
3. debouncer 合并 batch。
4. `HmrBatchProcessor` 沿 Vite moduleGraph 从 changed file 向 importers 传播，收集 affected ids。
5. 通过 loader anchors 选择需要重新执行的插件入口 target。
6. invalidate Vite moduleGraph 和 runner evaluated module cache。
7. `HmrExecutor` 重新 import target module。
8. `ModuleReplacer.replaceModule()`：
   - `stopModule(id, { cascadeDependents: false })`：先停旧模块运行态，但不在声明层提前删除 dependents；
   - 基于 core graph 收集旧模块插件的 dependent closure，并映射成 affected module ids；
   - `undeclareModule(id)`：移除旧声明；
   - 扫描新 exports，声明新的插件 ctor；
   - 归一化 constructor param token，避免 HMR 后同 id 不同 ctor 引用造成假缺依赖；
   - `syncRuntimeForModule(id)`：把本 module 中配置启用的插件重新注册进 core 草稿。
9. batch 末尾 `ctx.registry.commit()`。
10. commit 前，HMR 会先 sync runtime 报告的 affected modules 中“没有被本 batch 重新执行”的模块；这些 module 不一定被 Vite 选为 target，但会用 loader 已有 ctor 重新注册并重启。
11. 如果 commit 因 `MissingDependency` 失败，默认自动禁用缺依赖链上的已知插件，重新 sync 本 batch modules + affected modules，再 retry commit。

同步策略有两个效率约束：

- 正常路径下，已被 runner 重新执行并 `replaceModule()` 的 target 不会再立刻 `syncRuntimeForModule()` 一遍。
- retry 路径下，core commit 失败会回滚 draft，因此必须重新 sync 本 batch targets 和 DI affected modules；sync 函数内部按 module id 去重。

最终 summary 语义：

- `affectedModules`
  runtime 从旧 core DI graph 发现的 affected module ids，包含被替换模块本身和依赖它的模块。
- `syncedModules`
  HMR 实际成功调用 `syncRuntimeForModule()` 的模块；正常路径通常只包含未重新执行的 dependents，retry 路径也会包含 batch targets。
- `autoDisabled`
  missing-deps retry 中被持久禁用的插件名。
- `enabledButStopped`
  本次相关模块集合内，commit 后仍处于 enabled 但非 running 的插件名；用于解释“batch ok 但插件没起来”。
- `commit.restarted`
  从 core commit `touched` 扣除 add/remove/replace/fail 后推导出的纯重启插件名。

## 实用性判断

### 改插件自身后默认重启

符合。

插件 module 是 anchor 时，改它会触发重新执行。`replaceModule()` 会先停旧 module，再声明新 ctor，并按配置启用位重新注册，最后 commit。只要插件原本 enabled，它会在 HMR 后重启。

如果插件 disabled，HMR 只更新声明和 anchor，不会启动它。这是合理行为。

### 改插件依赖文件后重启插件

大体符合。

如果被改文件已经进入 Vite moduleGraph，HMR 会接受它，即使它不在初始 roots。batch graph 会沿 importer 方向找到最近的 plugin anchor。因此常见情况成立：

- `PluginA.ts` import `helper.ts`
- 改 `helper.ts`
- HMR 重新执行 `PluginA.ts`
- `PluginA` 重启

这符合开发期直觉。

### 改 provider 后依赖它的插件也跟着重启

符合当前实用要求。

在常见 DI 写法中，consumer 构造参数需要 import provider ctor，所以 Vite moduleGraph 会有 importer 边：

- `Consumer.ts` import `Provider.ts`
- 改 `Provider.ts`
- HMR affected graph 包含 `Consumer.ts`
- target 包含两个 anchors
- provider 和 consumer 都重新执行并重启

这时“依赖的也跟着重启”成立。

同时，runtime loader 会在 module replace 前基于 core graph 收集旧 provider 的 dependents，并把这些 dependents 映射回 module ids。HMR 在 commit 前会 sync 这些 affected modules，所以即使某个 consumer 没有被 Vite moduleGraph 选为重新执行 target，只要它已在 loader registry 中，仍会被重新注册并重启。

这条路径把“源码 import 图”与“DI graph 级联”分开处理：

- HMR 仍只负责文件变更、moduleGraph、runner import。
- runtime 负责 module/plugin catalog、affected module 映射、config enabled 同步。
- core 负责最终 stop/start 顺序和生命周期。

### 删除插件文件

基本符合。

删除文件时 `pruneMissingModules()` 会 runtime-only prune module：停止运行态、解除声明、移除 anchor，但保留 persisted enable bit。随后 batch commit 生效。

保留 enable bit 的好处是文件恢复后可自动按原状态启动；坏处是 UI 上可能看到“配置仍启用但插件已不 loaded”。这对 HMR 是可以接受的，但需要 read model 表达清楚。

### 缺依赖时是否影响其它插件

符合实用要求。

HMR batch commit 和 builtins preload 都有 `MissingDependency` 自动禁用策略。默认非 strict 下，失败链上的已知插件会被 persisted disable，然后重新 commit，使其它插件继续运行。

这对 dev host 很重要：一个临时坏掉的插件不应该让整个宿主不可用。

## 当前设计收敛

### 1. 三层职责保持独立

最终分工如下：

- core 只负责 DI graph、commit delta、拓扑 stop/start、restart cascade 和失败隔离。
- runtime 负责 module/plugin catalog、配置启用位、ctor token 归一化、DI affected modules 映射、batch rollback。
- HMR 负责文件变更、Vite moduleGraph、runner import、cache invalidation、commit/retry orchestration、summary 输出。

HMR 不直接读取 core graph 来推生命周期影响面；它只通过 `LoaderBatch.listAffectedModules()` 消费 runtime 的结果。这样 HMR 和 core 不形成隐式耦合。

### 2. HMR summary 已能解释主要 lifecycle 结果

summary 现在有：

- `ok`
  HMR batch orchestration 是否成功。
- `lifecycleOk`
  core commit 是否有插件启动失败。
- `commit.failed`
  core 明确报告的启动失败插件。
- `commit.restarted`
  core touched 中的纯重启插件。
- `affectedModules`
  DI 级联影响面来自哪些 module。
- `syncedModules`
  HMR 实际重新 sync 了哪些未重新执行或 retry 后需要重放的 module。
- `autoDisabled`
  哪些插件因为 missing dependency 被自动持久禁用。
- `enabledButStopped`
  哪些相关插件仍 enabled 但没有 running。

这组字段可以回答四个开发期问题：

- 这次哪些文件/模块被执行了？
- 哪些依赖模块虽然没被 Vite 选中，但被 DI affected modules 带着重启？
- 是否有插件被自动禁用了？
- batch 成功但插件没起来时，具体停在哪些插件上？

### 3. `replaceModule()` 明确保持 module 级替换

core 已经有 `replace()` 语义，默认会 alias 旧 token 并级联重启 dependent。

runtime HMR 当前仍以 module 为边界：

- 先停止旧 module 自身；
- 再 declare 新 ctor；
- 再 sync 未重新执行的 affected modules。

这样能处理“一个 module 导出多个插件 / exports 变化 / 变成非插件 module”。曾评估过对“同 id 单插件热更”局部调用 core `replace()`，但当前不采用：

- core `replace()` 会引入旧 token alias 到新 ctor 的语义，适合纯 core API。
- runtime loader 还要维护 moduleId / plugin name / exportKey / fork / status 查询，这些 read model 应继续以 module 声明事实为准。
- HMR 的通用 module replacement path 更容易保证 batch rollback 和 exports 变化的一致性。
- 已执行 target 不再重复 sync，未执行 dependent 才 sync，因此保留 module-level path 的额外成本可控。

### 4. `enable` 与 `start` 控制面语义已收敛

runtime op 中：

- `plugin.start`：启用并启动。
- `plugin.enable`：启用并启动。保留这个别名是为了符合 UI switch / CLI 的直觉。
- `plugin.enable-persisted`：只写持久启用位，不立即启动。
- `plugin.stop`：停止运行，保留持久启用位。
- `plugin.disable`：停止运行并关闭持久启用位。

## 剩余改进

### A. 同 id 单插件替换暂不走 core `replace()`

评估结论：暂不实现。

原因：

- core replacement 的 alias 语义会改变旧 token 的查询解析；对纯 core API 是合理的，但 runtime loader 的 module/plugin read model 更需要稳定。
- module-level HMR 必须覆盖新增、删除、重命名、多导出、非插件模块等情况。为单插件特例引入另一套 lifecycle path 会增加解释成本。
- 目前 HMR 已经避免已执行 target 的重复 sync，只对未执行 dependents sync；性能收益不足以抵消复杂度。

后续只有在 core 能提供“replace implementation but preserve read-key behavior”的更窄 API 时，再考虑重新评估。

### B. 继续补配置驱动依赖覆盖

已覆盖 base provider selection；仍建议继续补：

- fork selection 热更。
- dep override 热更。
- persisted-only enable 在 UI 外工具里的 round-trip。

### C. 增加覆盖测试

已补覆盖：

- provider module HMR 后，consumer 不在 Vite importer targets 中，仍能被 runtime affected modules 重新 sync。
- provider module HMR 后，依赖 base token 的 consumer 也能由 runtime affected modules 重新 sync。
- HMR executor 在 commit 前消费 runtime batch 的 affected modules。
- HMR executor summary 暴露 `affectedModules` / `syncedModules` / `autoDisabled`。
- HMR processor summary 暴露 batch 相关模块内的 `enabledButStopped`。
- 非 batch `replaceModule()` 会 sync affected dependents，但不会重复 sync 刚替换的 module。
- runtime `LoaderBatch` contract 已类型化，HMR 不再鸭子类型读取 affected modules。
- `plugin.enable` 会立即启动，`plugin.enable-persisted` 只写持久启用位。

仍建议补：

- fork selection / dep override 的配置驱动 HMR 覆盖。

## 推荐改造顺序

1. 继续补 fork selection / dep override 这类配置驱动依赖的 HMR 覆盖。
2. 若未来 core 提供更窄 replacement API，再重新评估 runtime HMR 单插件快路径。

整体判断：当前 HMR 已经满足日常“改插件源码自动重启”和“依赖它的插件也跟着重启”的实用要求；DI 依赖图级联已从“通常靠 moduleGraph 成立”推进到“runtime affected modules 明确同步”，同时避免了已执行 target 的重复 sync。
