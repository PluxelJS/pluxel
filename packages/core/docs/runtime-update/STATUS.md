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

## 稳定停点与刻意保留边界

Phase 2 已到阶段停点：Declaration ownership 下沉到 core。

已完成的 Phase 2 子集：

- core registry 已有 runtime module ownership read model：`runtimeModules`、`listRuntimeModuleItems(...)`、`getRuntimeModuleId(...)`。
- `RuntimeUpdateTransaction` 已有 `upsertModule(...)` / `removeModule(...)`，并带 rollback journal。
- `RuntimeUpdateTransaction` 已有 `markAffectedModule(...)` / `markAffectedModules(...)`，用于在不改变 ownership 的情况下记录本次更新涉及的 modules。
- core `CommitSummary.runtimeUpdate` 已带 `reason` 和 `affectedModules`；普通 commit 的 `affectedModules` 为空数组，runtime update commit 会填入事务标记过的 modules。
- runtime-dynamic 的 loader declaration transaction 在 `commit()` 时把 affected modules 的 ownership 同步到 core。
- loader transaction `rollback()` 不发布 core ownership，避免 loader 声明回滚后污染 core read model。
- runtime-dynamic 的 HMR batch 现在可把 module ownership 直接挂到 `RuntimeUpdateTransaction`，因此 `ctx.internalEvent.runtimeCommitted` 监听器在 HMR commit 内已能读取到最新的 `ctx.registry.runtimeModules`。
- loader 内部已删除一层纯重复 read-model：`name2ExportKey` 不再单独维护，公开 `exportKey` 查询改为从 `moduleMap` 按需推导，新增成本只发生在 catalog/UI 查询边界。
- loader 的 committed module-id 查询现在优先走 core ownership read model；`findModuleId(...)` 不再按 ctor 线性扫描全部 loader modules，affected-module/pruner 的 committed lookup 也先信 core。
- HMR scheduler 会把 replaced/affected/synced modules 标记到 runtime update transaction，便于 adapter 后续只读 commit summary。

刻意保留在 adapter/loader 层：

- module -> plugin declaration 的主要写入逻辑仍在 loader/HMR batch 层。
- `LoaderService.beginBatch()` 仍是实际 loader 声明事务，不只是 core transaction 的兼容 facade。
- HMR 失败重试后仍需要外层调用 `batch.syncModules(...)` 把 declarations 重新写回 core draft。
- core ownership 目前是 read model / journal，不负责 loader 的冲突处理、包名前缀、identity mutation、dependency override。
- missing-deps retry 仍需要外层 `batch.syncModules(...)` 把 declarations 重新写回 core draft；当前评估下，这一步依赖 loader 的 module declarations + config enablement + `syncRuntimeForModule()` 语义，若强行收进 core transaction 会重新引入边界污染，因此本阶段不做。

## Phase 2 收益总结

如果要把当前改动整理为一个 Phase 2 阶段提交，建议把收益明确表述为下面四类。

1. committed runtime module ownership 现在有了稳定的 core read model。
   - core 已经拥有 `runtimeModules` / `getRuntimeModuleId(...)` / `listRuntimeModuleItems(...)`。
   - HMR commit 的 `ctx.internalEvent.runtimeCommitted` 回调内已经可以读取到最新 ownership，不再存在“summary 已提交但 registry ownership 还没同步”的时间差。
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

Phase 3 已完成到可收口状态：constructor identity 已从 graph/runtime 语义身份中拆出，内部 canonical identity 使用 `RuntimePluginKey`。

已完成的 Phase 3 范围：

- runtime-dynamic 已删除 HMR path 上的 `normalizeCtorParams(...)` / `syncModuleParams(...)` / `setParamTokens(...)` metadata 改写补丁。
- core `PluginDefinitions` 在 provider declaration build 阶段读取 constructor deps，并把同 id / fork id 的漂移 ctor 解析为当前 `RuntimePluginKey`。
- dependency graph node key、runtime cache key、commit summary 的 `added` / `removed` / `replaced` / `availabilityChanged`、lifecycle issue plugin key、lifecycle id、watcher resolved key 都已迁到 `RuntimePluginKey`；lifecycle failure 通过 `ctx.internalEvent.runtimeCommitted` 的 `lifecycleReport.ok` / `lifecycleReport.issues` 和 lifecycle selector 观察，不再维护独立失败事件或派生失败数组。
- constructor token 仍作为 authoring API 和 compat alias 保留：`features.dep(SomeCtor)`、constructor params、base provider token、旧 `getInstance(Ctor)` / `isRunning(Ctor)` / `watchInstance(Ctor)` 仍可用，但都会在 build/planning/read-model 边界解析成 key。
- core `isRunning(...)` / `getInstance(...)` / `watchInstance(...)` 的显式 runtime read model 也通过同一 ownership read key 处理 ctor identity drift。
- 归一化只在 declaration/build 边界发生；无变化时复用原 deps array，不进入插件业务热路径。
- core runtime module ownership 增加 module revision，rollback/remove 同名 owner 时恢复最近上一任 owner，且较旧 snapshot restore 不会抢回仍然更新的 owner。
- 已补 focused tests 覆盖普通 plugin id 漂移、fork id 漂移、显式 runtime query 漂移、watcher 漂移、overlapping rollback owner 恢复、旧 snapshot 不抢新 owner。
- 已补 focused test 固定 Phase 3 核心不变量：graph node 是 runtime key 字符串，constructor 只作为 token alias。
- persisted dependency override 的运行时应用也已从 loader/control-plane metadata mutation 下沉到 core declaration overlay：
  - runtime-dynamic 不再对 override 调用 `setParamToken(...)` / `clearParamToken(...)`，只负责读取 config extra、解析 runtime ctor、必要时启用被选 dependency，然后把完整 overlay 发布给 `ctx.registry.replaceRuntimeDependencyOverrides(...)`。
  - runtime control-plane 的 set target 不再改写 constructor metadata，而是写入持久化 extra 后按完整 persisted state 构造 overlay，交给 core 在 declaration build 边界重建 provider declaration。
  - inspect 仍属于 runtime/control-plane read usecase，但 `effective` 优先反映 persisted selection；不存在 selection 或 selection 不可解析时才回落到 declaration/default token。
  - runtime update rollback 会恢复事务期间修改过的 dependency override overlay，避免 build 失败后 core declaration overlay 与 loader/config 回滚状态漂移。
  - 新增成本只在 override 写入、module declaration apply、provider declaration rebuild、commit/restart 边界出现，不进入插件实例业务热路径。

Phase 3 命名模型：

- `RuntimePluginKey` 是实际落地的内部 graph/runtime identity，格式为 `PluginName` 或 `PluginName#forkId`。
- `PluginIdentity` 是结构化边界概念，用于表达 `{ name, fork }`，进入 graph/runtime 前 canonicalize 为 string key。
- 不再引入对象形态的 `PluginKey`；它会增加比较/Map 复杂度，且当前 string key 已能直接映射到底层 slot graph。

Phase 3 性能判断：

- 新增成本停留在 declaration build、planning、read-model、commit summary 构造和 override 写入边界。
- 运行实例 cache 通过 `ensureByKey` / `peekByKey` 访问，底层仍是 graph slot + instance store；插件方法调用和依赖访问没有新增 registry Map lookup。
- 删除的成本包括 HMR path metadata mutation、constructor param cleanup、control-plane 全局 constructor metadata selection，以及 adapter 对 constructor drift 的额外补丁。
- 对稳定运行态性能近似零影响；对 HMR/control-plane 路径通常持平或正向，代价是 core declaration/compat resolver 代码短期更复杂。

Phase 4/5 已到稳定停点：adapter 已继续瘦身，旧补丁已删除；剩余边界属于 adapter 语义。

- HMR executor 仍知道 retry 后需要 re-sync affected/replaced modules。
- commit summary 已拆成 `pluginChanges` / `runtimeUpdate` / `lifecycleReport`；不再补 revision replacement 等字段，除非后续出现真实 consumer。
- worker fallback path、Tinypool worker entry resolution、runtime packaged manifest implicit path、HMR enabled-but-stopped 诊断、UI extension compiler entry base-dir lookup 已优先使用 core runtime module ownership read model，loader registry 只作为兼容 fallback。
- UI compiler / worker watcher 还没有完全统一成只消费 commit summary 或 plugin lifecycle；watch files、source entry、route dev capabilities 仍属于 runtime route 语义，不能下沉到 core。
- 外层 retry re-sync 属于 loader/config re-apply 语义；constructor param normalization patch 和 dependency override metadata mutation patch 已删除。

## 推荐下一步

Phase 3 已完成，Phase 4/5 已到稳定停点。后续不应继续为了“完成文档阶段”而推进；只有能删除真实复杂度的新证据才值得继续切。

当前判断：

- `missing-deps retry -> batch.syncModules(...)` 仍是外层 adapter 语义；若强行收进 core transaction，会把 loader/config re-apply 重新带回 core。这里应明确停止，而不是继续硬推。
- committed module ownership 的写入、rollback、`ctx.internalEvent.runtimeCommitted` 可见性和主要 read-path 已经尽量对齐到 core；loader 侧剩余 maps 主要承载冲突处理、未提交声明、primary provider/fork/pruner 这类宿主语义，不再是单纯“应该继续下沉的重复 committed read-model”。
- constructor dependency token 的真实输入面已收敛到 core declaration build，graph/read-model/summary/watchers 已使用 `RuntimePluginKey`；继续在 Phase 3 上加抽象的边际收益很低。

Phase 4/5 入口约束：

1. 只接受能继续删除 adapter/HMR/control-plane 复杂度的步骤。
2. 不要把 loader config/catalog side effect 收进 core；core 只接收 declaration、ownership、override overlay 这些事实。
3. commit summary 可以补字段，但不能演变成事件溯源或全量 update log。
4. 新增成本仍只能留在 declaration/build/commit 边界，不能进入依赖访问和插件生命周期热路径。

后续候选只在出现真实 consumer 或新重复复杂度时考虑：

1. 若未来有新的 loader/config abstraction 能真正删除 retry re-sync，再重新评估 `batch.syncModules(...)`。
2. 若 adapter 出现真实 consumer，再为 commit summary 补字段；不要预先设计 replacement revision/module info。
3. 若 UI compiler / worker watcher 出现重复读取 committed runtime ownership 的问题，再优先消费 commit summary 或 lifecycle event。
4. 清理 runtime-dynamic helper 时必须能删除一条真实重复路径，并配一个 focused regression test。

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
rg -n "ctx\\.ops|opsInvoke|opsDispatch|opsCatalog|opsToolsets|mcp-lite|registerRuntimeMcpTools|RUNTIME_TRANSPORT_PATHS\\.mcp|PluginOpsDemo|useRuntimeOpCatalog|useRuntimeOpsToolsets" packages docs package.json pnpm-lock.yaml
```

Phase 3 第一刀残留检查：

```sh
rg -n "setParamToken|clearParamToken|setParamTokens|normalizeCtorParams|TOKEN_NORMALIZED_WARN|syncModuleParams" packages/runtime-dynamic/src packages/runtime/src/api/usecases/pluginDependencies.ts packages/core/src/plugins/runtime
```
