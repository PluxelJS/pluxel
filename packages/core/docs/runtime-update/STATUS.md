# Runtime Update Status

更新日期：2026-06-19。

这是 runtime update 重构的接手状态文档。稳定设计和否决边界见 `packages/core/docs/runtime-update/DESIGN.md`，推进理由和收益风险见 `packages/core/docs/runtime-update/RATIONALE.md`；本文只记录当前做到哪里、还剩什么、下一步应该如何切。

## 已完成

Phase 1 已完成：

- `PluginService.beginUpdate()` 已实现，返回 bounded `RuntimeUpdateTransaction`。
- transaction 支持 `register` / `unregister` / `replace` / `restart` / `commit` / `rollback`。
- transaction 会记录 core pending start/restart checkpoint；build/verification 失败时可以 rollback 到事务开始前。
- HMR pipeline、runtime-dynamic、runtime-static 已迁到 `ctx.registry.beginUpdate(...)`。
- `commit({ rollbackOnFailure: false })` 已用于 HMR/loader 的 missing-deps retry 场景；retry 前仍由调用方重新 sync 仍启用的 declarations。
- `strict` 语义只用于把启动失败报告为 error；插件已经部分启动并确认 graph 后，transaction 不假装能完整倒回运行态。

Runtime control-plane 清理已完成：

- runtime 内核不再注册 `ctx.ops`。
- runtime RPC 不再暴露 `opsCatalog` / `opsInvoke` / `opsDispatch` / `opsToolsets`。
- 插件 config/status/dependency/fork 控制面改为明确的 `src/api/usecases/*` + RPC methods。
- workbench Ops UI、runtime ops API、ops toolset read model、ops demo 已删除。
- `packages/ops` 可以继续作为底层工具包存在，但 runtime 不再接入它。

MCP 接入已剥离：

- runtime 不再提供 `/mcp` transport。
- runtime、runtime-dynamic 不再依赖 `mcp-lite`。
- runtime-dynamic 的 workspace MCP tools 已删除。
- 文档只保留边界说明：未来若重新接 MCP，应复用 `src/api/usecases/*`，不要在 runtime 内核里保留 carrier glue。

## 未完成

Phase 2 已到阶段停点：Declaration ownership 下沉到 core。

已完成的 Phase 2 子集：

- core registry 已有 runtime module ownership read model：`runtimeModules`、`listRuntimeModuleItems(...)`、`getRuntimeModuleId(...)`。
- `RuntimeUpdateTransaction` 已有 `upsertModule(...)` / `removeModule(...)`，并带 rollback journal。
- `RuntimeUpdateTransaction` 已有 `touchModule(...)` / `touchModules(...)`，用于在不改变 ownership 的情况下记录本次更新涉及的 modules。
- core `CommitSummary` 已带 `reason` 和 `touchedModules`；普通 commit 的 `touchedModules` 为空数组，runtime update commit 会填入事务标记过的 modules。
- runtime-dynamic 的 loader declaration transaction 在 `commit()` 时把 touched module ownership 同步到 core。
- loader transaction `rollback()` 不发布 core ownership，避免 loader 声明回滚后污染 core read model。
- runtime-dynamic 的 HMR batch 现在可把 module ownership 直接挂到 `RuntimeUpdateTransaction`，因此 `afterCommit` 监听器在 HMR commit 内已能读取到最新的 `ctx.registry.runtimeModules`。
- loader 内部已删除一层纯重复 read-model：`name2ExportKey` 不再单独维护，公开 `exportKey` 查询改为从 `moduleMap` 按需推导，新增成本只发生在 catalog/UI 查询边界。
- loader 的 committed module-id 查询现在优先走 core ownership read model；`findModuleId(...)` 不再按 ctor 线性扫描全部 loader modules，affected-module/pruner 的 committed lookup 也先信 core。
- HMR scheduler 会把 replaced/affected/synced modules 标记到 runtime update transaction，便于 adapter 后续只读 commit summary。

仍未完成：

- module -> plugin declaration 的主要写入逻辑仍在 loader/HMR batch 层。
- `LoaderService.beginBatch()` 仍是实际 loader 声明事务，不只是 core transaction 的兼容 facade。
- HMR 失败重试后仍需要外层调用 `batch.syncModules(...)` 把 declarations 重新写回 core draft。
- core ownership 目前是 read model / journal，不负责 loader 的冲突处理、包名前缀、identity mutation、dependency override。
- missing-deps retry 仍需要外层 `batch.syncModules(...)` 把 declarations 重新写回 core draft；当前评估下，这一步依赖 loader 的 module declarations + config enablement + `syncRuntimeForModule()` 语义，若强行收进 core transaction 会重新引入边界污染，因此本阶段不做。

## Phase 2 收益总结

如果要把当前改动整理为一个 Phase 2 阶段提交，建议把收益明确表述为下面四类。

1. committed runtime module ownership 现在有了稳定的 core read model。
   - core 已经拥有 `runtimeModules` / `getRuntimeModuleId(...)` / `listRuntimeModuleItems(...)`。
   - HMR commit 的 `afterCommit` 回调内已经可以读取到最新 ownership，不再存在“summary 已提交但 registry ownership 还没同步”的时间差。
2. runtime declaration update 的事务边界更清楚了。
   - core transaction 负责 ownership journal、rollback 和 commit metadata。
   - loader transaction 继续只负责 loader 自己的声明层状态，不再假装拥有 committed runtime state。
3. adapter/loader 的重复 committed read-model 明显减少了。
   - `name2ExportKey` 已删除，公开 `exportKey` 查询改为按需从 `moduleMap` 推导。
   - committed module-id query 优先走 core ownership，`findModuleId(...)` 不再按 ctor 线性扫描全部 loader modules。
4. Phase 2 的停止边界已经明确，不会再把 loader/config/HMR 语义错误地下沉到 core。
   - `missing-deps retry -> batch.syncModules(...)` 仍保留在 adapter。
   - loader 剩余 maps 主要服务于冲突处理、未提交声明、primary provider/fork/pruner，不再是“纯 committed ownership 重复数据”。

## Phase 2 提交建议

如果整理为一个阶段性大提交，建议提交说明围绕“Declaration ownership 下沉到 core 已完成到可停点”来写，而不是把它描述成“runtime update 全部完成”。

建议提交包含：

- `PluginService` 的 runtime ownership read model / transaction journal / commit metadata 相关变更。
- runtime-dynamic 中把 ownership 发布挂到 `RuntimeUpdateTransaction` 的变更。
- loader committed query 收敛到 core ownership、重复索引删除的变更。
- 对应 focused tests 和 runtime-update 文档更新。

建议不要混入：

- 与 Phase 2 无关的 workspace/package 调整。
- 提前引入的 `PluginKey` 壳子或 graph identity 抽象。
- 试图把 `missing-deps retry` 强收进 core transaction 的半成品。

Phase 3 已推进到第一处稳定停点：constructor dependency token 归一化已从 loader/HMR patch 下沉到 core declaration build。

已完成的 Phase 3 子集：

- runtime-dynamic 已删除 HMR path 上的 `normalizeCtorParams(...)` / `syncModuleParams(...)` / `setParamTokens(...)` metadata 改写补丁。
- core `PluginDefinitions` 在 provider declaration build 阶段读取 constructor deps，并通过 registry ownership read model 把同 id / fork id 的漂移 ctor 归一到当前 runtime owner ctor。
- core `isRunning(...)` / `getInstance(...)` / `watchInstance(...)` 的显式 runtime read model 也通过同一 ownership read key 处理 ctor identity drift。
- 归一化只在 declaration/build 边界发生；无变化时复用原 deps array，不进入插件业务热路径。
- core runtime module ownership 增加 module revision，rollback/remove 同名 owner 时恢复最近上一任 owner，且较旧 snapshot restore 不会抢回仍然更新的 owner。
- 已补 focused tests 覆盖普通 plugin id 漂移、fork id 漂移、显式 runtime query 漂移、watcher 漂移、overlapping rollback owner 恢复、旧 snapshot 不抢新 owner。
- persisted dependency override 的运行时应用也已从 loader/control-plane metadata mutation 下沉到 core declaration overlay：
  - runtime-dynamic 不再对 override 调用 `setParamToken(...)` / `clearParamToken(...)`，只负责读取 config extra、解析 runtime ctor、必要时启用被选 dependency，然后把 overlay 发布给 `ctx.registry.setRuntimeDependencyOverrides(...)`。
  - runtime control-plane 的 set target 不再改写 constructor metadata，而是写入持久化 extra 后按完整 persisted state 构造 overlay，交给 core 在 declaration build 边界重建 provider declaration。
  - inspect 仍属于 runtime/control-plane read usecase，但 `effective` 优先反映 persisted selection；不存在 selection 或 selection 不可解析时才回落到 declaration/default token。
  - 新增成本只在 override 写入、module declaration apply、provider declaration rebuild、commit/restart 边界出现，不进入插件实例业务热路径。

Phase 3 完整 PluginKey graph 仍未完成：

- graph 身份仍以 constructor token 为主。
- `PluginKey = id + fork` 还没有成为 dependency graph、status、watcher、enablement 的统一语义身份。
- decorator metadata 中的 constructor dependency token 目前只在 declaration build 阶段归一到 committed owner ctor，还没有统一解析为 `PluginKey`。
- runtime dependency override overlay 仍以 consumer plugin id 为 key，并在 declaration build 时覆盖 constructor params；这是为了删除 metadata mutation patch 的窄入口，不是完整 graph identity 迁移。
- update planning path 仍按 graph token 解析，不走 runtime read-key；这是刻意保留，因为 HMR replace/unregister 需要能指向旧 graph key，不能被已更新的 module ownership 抢先改写目标。
- 仍不应提前引入完整 `PluginKey` graph；下一步必须继续以能删除旧复杂度为准。

Phase 4/5 未完成：adapter 继续瘦身和旧补丁删除。

- HMR executor 仍知道 retry 后需要 re-sync affected/replaced modules。
- commit summary 还不是完整的 `RuntimeUpdateSummary`；已有 `reason` / `touchedModules`，但缺少 `autoDisabled`、revision replacement 等稳定字段。
- UI compiler / worker watcher 还没有统一改成只消费 commit summary 或 plugin lifecycle。
- 外层 retry re-sync、与 core transaction 重叠的 HMR helper 仍需在后续阶段删除；constructor param normalization patch 和 dependency override metadata mutation patch 已删除。

## 推荐下一步

Phase 2 目前已到自然停点，并已完成 Phase 3 第一处窄入口；后续进入完整 PluginKey graph 前仍必须保持入口很窄。

当前判断：

- `missing-deps retry -> batch.syncModules(...)` 仍是外层 adapter 语义；若强行收进 core transaction，会把 loader/config re-apply 重新带回 core。这里应明确停止，而不是继续硬推。
- committed module ownership 的写入、rollback、`afterCommit` 可见性和主要 read-path 已经尽量对齐到 core；loader 侧剩余 maps 主要承载冲突处理、未提交声明、primary provider/fork/pruner 这类宿主语义，不再是单纯“应该继续下沉的重复 committed read-model”。
- 因此继续停留在 Phase 2 的边际收益已经明显下降；constructor dependency token 的真实输入面已收敛到 core declaration build，PluginKey graph 的输入边界比之前清楚。

Phase 3 后续入口约束：

1. 只接受能继续删除现有 compat/adapter 复杂度的步骤。
2. 下一步不要直接改完整 graph；优先让 dependency token 解析开始产出稳定 key，同时保留现有 authoring API 兼容。
3. 不要先引入 `PluginKey` 抽象壳子、provider/kernel 体系或新的通用 policy；没有删除旧补丁的抽象先不做。
4. 新增成本仍只能留在 declaration/build/commit 边界，不能进入依赖访问和插件生命周期热路径。

推荐的下一步候选：

1. 盘点 dependency token canonicalization 与 override overlay 之后仍保留的 constructor identity compat 面，确认 fork/base alias、status/watchers 是否还能各删一条旧分支。
2. `depOverrides.apply(...)` 中读取 config extra、fork catalog、enable selected dependency 仍依赖 loader/control-plane 语义，本阶段继续留在 adapter/usecase；不要把 config/catalog side effect 收进 core。
3. 为这些输入面补 focused tests，固定“同 id / 同 fork id 不同 ctor 引用”和“persisted selection 不改写 constructor metadata”的 key 级预期。
4. 只有在能删除一条现有 compat 分支时，才引入最小 `PluginKey`/canonical key 解析。

## 明确不要做

- 不要把 Vite module graph 放进 core；core 只接收 declaration changed 的事实。
- 不要恢复 ops/MCP runtime 接入；未来 MCP 应作为 adapter 复用 usecases。
- 不要抽 `RuntimeKernel + SourceDriver + ArtifactProvider`，除非未来有新的充分证据证明 UI federation、worker、static build 共享了足够多的生命周期。
- 不要让插件业务热路径访问 registry Map；key normalization 应发生在 declaration/commit/build 边界。

## 快速验证命令

核心行为：

```sh
./node_modules/.bin/vitest run packages/core/tests/PluginService.test.ts \
  packages/runtime/tests/services/runtime-control-plane.test.ts \
  packages/runtime/tests/services/public-surface.test.ts
```

构建面：

```sh
./node_modules/.bin/tsdown --config packages/runtime/tsdown.config.ts
./node_modules/.bin/tsdown --config packages/runtime-dynamic/tsdown.config.ts
```

残留旧语义检查：

```sh
rg -n "ctx\\.ops|opsInvoke|opsDispatch|opsCatalog|opsToolsets|mcp-lite|registerRuntimeMcpTools|HMR_TRANSPORT_PATHS\\.mcp|PluginOpsDemo|useRuntimeOpCatalog|useRuntimeOpsToolsets" packages docs package.json pnpm-lock.yaml
```

Phase 3 第一刀残留检查：

```sh
rg -n "setParamToken|clearParamToken|setParamTokens|normalizeCtorParams|TOKEN_NORMALIZED_WARN|syncModuleParams" packages/runtime-dynamic/src packages/runtime/src/api/usecases/pluginDependencies.ts packages/core/src/plugins/runtime
```
