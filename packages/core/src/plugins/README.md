# 插件系统（core/plugins）

这套目录承载的是 **核心插件系统**：装饰器/元数据、DI 定义层（draft/build/commit）、运行时 registry（commit/restart/unregister/optional/fork），以及插件生命周期 actor。

插件系统的测试更适合集中放在 `packages/core/tests/`（黑盒/集成式，用 `@pluxel/core/test` 跑真实插件行为），这里主要放实现与约定说明。

## 目录结构（“主文件 + internal 基础设施”）

### 主文件（入口更显眼）

- `PluginService.ts`：运行时 orchestrator（commit、restart、unregister、optional、fork 管理、实例缓存等）
- `PluginActor.ts`：单插件生命周期状态机（start/stop/retry/asyncError）+ selectors
- `LifecycleManager.ts`：把 actor 挂到插件实例上、封装超时/停止策略（供 `PluginService` 使用）
- `fork.ts`：fork ctor 的生成与 identity 规则（`id#forkId`）

### internal/（底层设施与实现细节）

- `internal/BasePlugin.ts`：`ctx` 注入与 lifecycle runtime 适配（构造热路径）
- `internal/PluginDecorator.ts` + `internal/decorator/*`：`@Plugin/@Config`、元数据存储、param tokens、requiredDeps、configSource、clone definition
- `internal/PluginDefinitions.ts`：DI 定义层（draft 注册/撤销 + build/confirm/resetDraft）
- `internal/decoratorRuntime.ts`：跨插件 decorator 运行时（按 token resolve 依赖 + 注入 caller ctx + 缓存）
- `internal/runtime/*`：`PluginService` 使用的纯逻辑（init plan / start/stop scheduler / optional resolver）

## 维护原则

- 对外 API 通过 `plugins/index.ts` 统一导出；内部实现尽量收敛到 `internal/`，减少主目录噪音。
- 任何改动优先用 `packages/core/tests/` 的黑盒场景验证行为不变。
- `registry.optional()` 的 effect 会绑定到 **caller ctx**（而不是被观察插件的 ctx），并通过 `callerCtx.collectEffect()` 跟随调用方插件的生命周期自动清理；若在 `commit()` 期间调用，会把首次执行推迟到 `afterCommit`，避免 init 阶段“早期 miss”。
