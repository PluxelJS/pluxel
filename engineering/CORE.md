# Core

`@pluxel/core` 定义 Plugin definition/node、DI graph、Context 和 generation lifecycle，不拥有宿主能力。

## 负责

- `PluginDefinitionSlot`、`PluginNodeSlot` 与结构化 entry/definition/node address；
- 每个 evaluated constructor 唯一且可重复读取的 frozen lowered candidate、immutable definition/node record 与 monotonic definition revision；
- `Context`、service registry、caller-bound dependency view 与 DI；
- node materialize/dematerialize/restart、definition-wide replacement、provider default、dependency override 与原子 commit；
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
- `isRunning/getInstance/resolvedDependencies/resolvePluginNode/isMaterialized/watch` 等只读入口只做 non-creating lookup；不存在的
  address、constructor token 或被拒绝的 restart/remove/binding 不留下 slot。只有 materialize 与显式 internal intern入口创建slot。
- 未经过 Pluxel semantic pass 的 Plugin 源码明确失败；DI 只读取 lowered definition/edge facts。

## Definition、node 与 generation

Core 对三个不同生命周期对象使用不同记录：

- `ConcretePluginDefinitionRecord` 固定一个 candidate revision 的 implementation、schema、required/optional edge、provider relation 与
  `forkable` fact；abstract token 没有 record；
- `PluginNodeRecord` 固定 default/fork node address，并引用该 definition record；未 materialize 的 durable fork 不产生 Core node record；
- generation 是 node 的一次 Context、instance、caller facade、admission gate 与 effects 生命周期，不进入 address，也不复用 constructor 充当 identity。

definition slot 与 node slot 在进程内稳定；replacement 原子创建新 definition record，并通过 definition-to-materialized-node index
以 O(k) 枚举该 definition 的全部 node record。zero-fork 且 disabled 的 definition 不创建 node/fork table 或 synthetic subclass。

### Graph snapshot 与成本模型

Core graph 使用 host-lifetime、append-only 的 numeric slot identity；remove 后 slot tombstone 保留到 host dispose，以保证同一 address
不会在进程内得到第二个 slot。active declaration、record、generation、Context、effects 与 caller cache 不随 tombstone 保留。

每个 immutable graph snapshot 的 slot table 使用四层、每层 64 路的 radix structure sharing。draft 是 immutable base 加 sparse
delta；commit 只复制发生变化的 radix path、dependency adjacency 与 token index overlay，未触及的页保持引用相等。cycle、affected
closure 与 dependent traversal 使用可复用 epoch marks 和 sparse work queue。因此固定 k 的 definition replacement 不复制全图，也不按
`slotCount` 分配临时 typed array；成本由变更的 k 个 node、被影响的 edge 与实际触及页决定。

`GraphSnapshot`、radix table 和 tombstone layout 都是 Core internal representation，不属于 1.0 public contract。公共
`CommitSummary` 只投影 `pluginChanges`、`lifecycleReport` 与 `runtimeUpdate.reason`；内部 watcher 才接收本次 committed graph。

硬成本断言位于 `packages/core/tests/PluginDefinitions.cost-model.test.ts`、`PluginService.cost-model.test.ts` 与 internal DI tests；趋势探针使用：

```sh
pnpm --filter @pluxel/core bench:caller-view
pnpm --filter @pluxel/core bench:fork-cost
```

benchmark 不承诺跨机器延迟阈值；架构契约是 absent read 零物化、definition family 枚举 O(k)、固定 k update 不扫描/复制无关 graph，
以及 fork removal 后只保留 host-lifetime identity/graph tombstone。

Core update 是 bounded top-level transaction。`prepare()` 完成 candidate/address、forkability、binding、combined graph 与 closure 验证；
prepare 前的异常可 rollback draft。prepared commit 进入 lifecycle stop/start 后已越过 point of no return，post-commit config/init/drain
failure 只进入结构化 lifecycle report，不把旧 generation 冒充成已回滚的当前状态。

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

generation construction 通过同步 construction stack 把 node Context 注入原始 implementation；default 与 fork 都以同一个
implementation 作为 `new.target`，不创建 subclass。required 与 optional dependency 共用 consumer/provider generation pair cache 的
caller facade；普通作者字段读写委托 raw provider，method/getter receiver 保持 caller Context。旧 facade 的 method/getter/write 都经过
provider admission gate，replacement 后不能调用旧 generation。Core internal state mutation fail-fast；Plugin inheritance 中的 ECMAScript
`#private` 由 semantic pass 拒绝。

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
- `packages/core/src/toolchain.ts`
- `packages/core/src/plugins/runtime/PluginService.ts`
- `packages/core/src/plugins/composition/caller-view.ts`
- `packages/core/src/internal/di/`
- `packages/core/src/internal/fsm/`
- `packages/core/src/plugins/runtime/plugin-service/LifecycleManager.ts`
- `packages/core/src/plugins/composition/`
- `packages/core/src/plugins/runtime/part-definition.ts`
- `packages/core/src/services/effects/EffectsService.ts`
- `packages/core/src/services/config/`

只验证 DI、lifecycle、optional restart、config 和 effects 时使用 core test host；需要 runtime service 时进入
`@pluxel/runtime/test`。测试中的 Plugin 仍必须经过 semantic lowering；unsafe facts helper 只用于明确的 core/runtime 内部测试。
