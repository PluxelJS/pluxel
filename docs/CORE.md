# Core

`@pluxel/core` 定义插件语义，不拥有宿主能力。

## 负责

- `Context` 与 service registry；
- plugin definition、required dependency graph 和 DI；
- `register`、`replace`、`restart`、`commit`；
- start/stop 顺序、failure propagation 和 `CommitSummary`；
- per-plugin effects scope；
- feature/config declaration 与校验快照。
- opaque `OptionalPluginRef` 声明、instance watcher 与 commit-settled internal scheduling hook。

## 不负责

- HTTP、RPC、SSE、Workbench Plane；
- 配置或业务数据持久化；
- workspace scan、package install、Vite、HMR；
- optional package import、retry 和 route diagnostics；
- 进程退出、健康检查和部署策略。

## 生命周期不变量

```text
draft graph -> verify -> stop dependents -> start providers -> CommitSummary
```

- required dependency 只来自 constructor metadata。
- provider 启动失败只阻塞 required dependents。
- replacement 复用 stop/start 和 effects cleanup。
- lifecycle report 是事实源，宿主基于它制定策略。
- generation 停止时先关闭内部 owner invocation gate 并等待已接纳调用退出，再执行插件 `stop()`。
- effects 只 drain 显式登记的 cleanup、Disposable 和 acquired resource；异步任务应返回可等待释放的 handle。

## Feature 边界

- `features.use()`：required plugin-local composition。
- `features.load()`：通过 `defineLazyFeature()` 声明的 lazy composition。
- 插件间 optional integration 属于 `plugins.use()`，不属于 FeatureHost；package-optional ref 的解析由 runtime
  availability service 承担，core 不执行 loader。

## 实现入口

- `packages/core/src/plugins/runtime/PluginService.ts`
- `packages/core/src/plugins/runtime/PluginDefinitions.ts`
- `packages/core/src/internal/di/`
- `packages/core/src/internal/fsm/`
- `packages/core/src/plugins/runtime/plugin-service/LifecycleManager.ts`
- `packages/core/src/plugins/decorators/`
- `packages/core/src/plugins/composition/`
- `packages/core/src/services/effects/EffectsService.ts`

仅验证 DI、生命周期、feature 和 effects 时使用 core test host；需要 runtime service 时进入 `@pluxel/runtime/test`。
