# Core

`@pluxel/core` 定义 Plugin definition/node、DI graph、Context 和 generation lifecycle，不拥有宿主能力。

## 负责

- `PluginDefinitionSlot`、`PluginNodeSlot` 与结构化 entry/definition/node address；
- lowered Plugin definition facts、required/optional edge 和 abstract provider relation；
- `Context`、service registry、caller-bound dependency view 与 DI；
- `register`、`replace`、`restart`、`commit` 和 fork node；
- provider-first start、consumer-first stop、failure propagation 与 `CommitSummary`；
- per-generation effects、owner invocation gate 与 late `init()` cleanup；
- PluginPart containment tree、owner-bound child Context/effects 与 children-before-owner startup；
- Plugin/Part composite object config declaration、校验与 normalized aggregate snapshot；
- init-time `PluginRef` optional resolution、slot-aware runtime reads 和明确的 internal commit subscription。

## 不负责

- HTTP、RPC、SSE、Workbench Plane；
- 配置或业务数据持久化；
- workspace scan、package install、Vite、HMR；
- optional package import、安装、retry 或 absent-module protocol；
- 进程退出、健康检查和部署策略。

## Identity 与 DI 不变量

- graph identity 来自 canonical entry + root named export；class name、constructor 和 `displayName` 都不是 key。
- package Plugin 只从 package root 的唯一 named export 进入 catalog；source Plugin 使用 route 规范化的 source entry。
- required dependency 只来自 semantic pass lower 的 constructor value-import provenance。
- optional dependency只来自 lower 后的 non-exported module-level `definePluginRef<T>()`；Part optional edge 合并到 owning Plugin，不执行 runtime import。
- Core intern 结构化 address 后只按 slot object 查图；持久化 snapshot 不被 stringify 成作者协议。
- 未经过 Pluxel semantic pass 的 Plugin 源码明确失败；DI 只读取 lowered definition/edge facts。

## 生命周期不变量

```text
draft graph -> verify combined required/optional graph -> stop plan -> start plan -> CommitSummary
```

- provider 启动失败只阻塞 required dependents；optional consumer 走 absent 路径。
- optional provider 的 running generation 出现、消失或 replacement 时，consumer 与其 required dependent closure 在同一
  plan 中最多重启一次；consumer effects 必须在 provider 停止前 drain。
- generation 停止时先关闭 owner invocation gate、abort generation，再 drain effects。
- `init()` 返回的 cleanup/disposable 自动进入当前 effects；正常停止、rollback、replacement、optional restart 与 shutdown
  不调用第二套 teardown hook。
- abort/timeout 后迟到的 `init()` fulfillment 不会重新发布 running；迟到返回的 cleanup 会立即执行。
- lifecycle report 是事实源，宿主基于它制定退出、告警或降级策略。

## 内部组成与事件

简单内部拆分使用普通 class/function 与 `ctx.effects.scope()`。同时需要自己的 config slice、effects scope、nested
composition 或 owner-bound capability registration 时使用 `PluginPart`；它是 generation-local containment，不是第二张 graph。
Part child Context 的 service view 惰性缓存，不回灌共享 service 的 mutable `ctx`；未声明 owner binding 的 service 保持
owning Plugin view，root service 原样共享。需要独立失败传播、启停、replacement 或治理的组成成为 Plugin。

公开的固定事件集合使用具名 `EvtChannel` 属性；Core lifecycle 和 route invalidation 使用明确的 internal subscription，
不共享 Context global event bus。

## 实现入口

- `packages/core/src/plugins/runtime/identity.ts`
- `packages/core/src/plugins/runtime/definition.ts`
- `packages/core/src/plugins/runtime/PluginService.ts`
- `packages/core/src/internal/di/`
- `packages/core/src/internal/fsm/`
- `packages/core/src/plugins/runtime/plugin-service/LifecycleManager.ts`
- `packages/core/src/plugins/composition/`
- `packages/core/src/plugins/runtime/part-definition.ts`
- `packages/core/src/services/effects/EffectsService.ts`
- `packages/core/src/services/config/`

只验证 DI、lifecycle、optional restart、config 和 effects 时使用 core test host；需要 runtime service 时进入
`@pluxel/runtime/test`。测试中的 Plugin 仍必须经过 semantic lowering；unsafe facts helper 只用于明确的 core/runtime 内部测试。
