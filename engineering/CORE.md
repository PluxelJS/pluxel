# Core

`@pluxel/core` 定义 Plugin definition/node、DI graph、Plugin Context projection 和 generation lifecycle，不拥有宿主能力。
通用 Context host kernel 由公开的 `@pluxel/context` 提供；Core 源码直接复用它，并在发布产物中完整内联。

## 负责

- `PluginDefinitionSlot`、`PluginNodeSlot` 与结构化 entry/definition/node address；
- 每个 evaluated constructor 唯一且可重复读取的 frozen lowered candidate、immutable definition/node record 与 monotonic definition revision；
- 基于 `@pluxel/context` immutable host 的 generation scope、owner projection、caller-bound dependency view 与 DI；
- node materialize/dematerialize/restart、definition-wide replacement、provider default、dependency override 与原子 commit；
- provider-first start、consumer-first stop、failure propagation 与 `CommitSummary`；
- per-generation effects、owner invocation gate 与 late `init()` cleanup；
- pre-root、package-private generation finalization 与 commit publication authority；
- PluginPart containment tree、Part constructor requirement lifting、owner-bound child Context/effects 与 children-before-owner startup；
- Plugin/Part composite object config declaration、校验与 normalized aggregate snapshot；
- init-time `PluginRef` optional resolution、slot-aware runtime reads 和明确的 internal commit subscription。

## 不负责

- HTTP、RPC、SSE、Workbench Plane；
- 配置或业务数据持久化；
- workspace scan、package install、Vite、HMR；
- optional package import、安装、retry 或 absent-module protocol；
- 进程退出、健康检查和部署策略。

## Context capability kernel

`@pluxel/context` 是公开、同步且 host-neutral 的 Context kernel。它在 `createContextHost()` 时把 opaque capability
installation 编译成固定 shape；standalone host 可以在 root 创建前组合自己的能力，或用 `overrides` 替换基础集合中的同一
descriptor。override 必须保持原 scope 与 projected property，host 编译完成后没有 install/mutate API。

Core 只把这个通用 kernel 映射到 Plugin 生命周期。Runtime 与受信任 framework route 在 root 创建前组合固定 capabilities；
业务 Plugin 继续通过 Plugin graph 表达依赖，不能借助 module evaluation、Plugin `init()` 或 route side effect 修改既有
Runtime Context。

kernel 使用三个作用域，Core 对它们作如下映射：

| Kernel scope | Core 中的 backing identity         | Core 中的投影                          |
| ------------ | ---------------------------------- | -------------------------------------- |
| root         | 每个 root 一份                     | root property；显式 resolve 可共享     |
| scope        | 每次 Plugin generation 一份        | Plugin、Part 与 caller view 共享       |
| owner-view   | root backend 一份、owner view 多份 | Plugin、Part、caller edge 各自惰性缓存 |

Context host、root、scope、child 的创建都不会调用 capability factory。第一次读取 projected property 或调用
`resolveContextCapability()` 才构造对应值，成功值按其 scope 缓存；这就是 strict lazy，不存在隐式 eager 分支。
`@pluxel/context` 没有 `prepare()`、`dispose()` 或异步生命周期协议，资源预热与回收始终由上层 host/framework 明确拥有。

plan-local prototype getter 直接调用预编译 resolver，再读取 dense array slot；cached getter 不做 Map/string lookup、scope branch
或闭包分配。descriptor identity 的 `Map` 只在 host compile 和显式 resolve 时把 capability object identity 映射到 numeric slot。
`Object.create(null)` 只适合 string/symbol property lookup，不能替代 object identity；趋势探针位于
`packages/context/bench/context.bench.ts`。

每个 host 的 capability factory closure 只捕获自身已解析、冻结的输入。Context 不暴露 host config，也不持有可被冷 factory
稍后观察到的 mutable config object。caller-derived view 共享 provider root/generation backing，但拥有独立 owner-view cache 和
readonly caller pin；它不是 containment parent，因此 caller A/B 并发冷访问不会互相污染 owner attribution。

Core 不给 capability installation 增加第二套生命周期。Runtime 若需要在 Plugin lifecycle 前确认 IO/backend readiness，使用
自己的显式 prepare 阶段主动读取所需 lazy capability，再调用该 service 的领域启动 API；失败与重试语义由 Runtime host 拥有。

Core workspace 在源码层把 `@pluxel/context` 声明为 `devDependencies: workspace:*`，并由 tsdown 的 `alwaysBundle` 同时内联
JavaScript 与 declarations。发布的 `@pluxel/core` 不要求消费者安装 `@pluxel/context`，也不留下对它的生产 import；需要直接
创建 standalone Context host 的消费者才单独依赖 `@pluxel/context`。

kernel registry 属于每个 evaluated module instance，不放入 `globalThis`。因此 Core 内联 kernel 与 standalone
`@pluxel/context` 可以在同一 realm 合法共存，但 capability descriptor、installation、plan 和 Context 不能跨
kernel 传递。该编程错误在边界校验时诊断；开发期 host/runner 的同一 package identity 由 HMR bridge 保持，
不通过恢复全局 fatal singleton 实现。

## Identity 与 DI 不变量

- graph identity 来自 canonical entry + root named export；class name、constructor 和 `displayName` 都不是 key。
- package Plugin 只从 package root 的唯一 named export 进入 catalog；source Plugin 使用 route 规范化的 source entry。
- required dependency 只来自 semantic pass lower 的 Plugin/PluginPart constructor value-import provenance。Core 把 root direct requirements
  与 reachable Part requirements 按 definition identity 聚合到 owning Plugin graph，不给 Part 创建 node。
- optional dependency只来自 lower 后的 non-exported module-level `definePluginRef<T>()`；Part optional edge 合并到 owning Plugin，不执行 runtime import。
- Core intern 结构化 address 后只按 slot object 查图；持久化 snapshot 不被 stringify 成作者协议。
- `isRunning/getInstance/resolvedDependencies/resolvePluginNode/isMaterialized/watch` 等只读入口只做 non-creating lookup；不存在的
  address、constructor token 或被拒绝的 restart/remove/binding 不留下 slot。只有 materialize 与显式 internal intern入口创建slot。
- 未经过 Pluxel semantic pass 的 Plugin 源码明确失败；DI 只读取 lowered definition/edge facts。

## Definition、node 与 generation

Core 对三个不同生命周期对象使用不同记录：

- `ConcretePluginDefinitionRecord` 固定一个 candidate revision 的 implementation、schema、root ordered constructor requirements、
  aggregated required/optional edge、Part tree、provider relation 与 `forkable` fact；abstract token 没有 record；
- `PluginNodeRecord` 固定 default/fork node address，并引用该 definition record；未 materialize 的 durable fork 不产生 Core node record；
- generation 是 node 的一次 Context、instance、caller facade、admission gate 与 effects 生命周期，不进入 address，也不复用 constructor 充当 identity。

definition slot 与 node slot 在进程内稳定；replacement 原子创建新 definition record，并通过 definition-to-materialized-node index
以 O(k) 枚举该 definition 的全部 node record。zero-fork 且不在 effective desired graph 中的 definition 不创建 node/fork table 或 synthetic subclass。

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
pnpm --filter @pluxel/context bench
```

benchmark 不承诺跨机器延迟阈值；架构契约是 absent read 零物化、definition family 枚举 O(k)、固定 k update 不扫描/复制无关 graph，
以及 fork removal 后只保留 host-lifetime identity/graph tombstone。

Core update 是 bounded top-level transaction。`prepare()` 完成 candidate/address、forkability、binding、combined graph 与 closure 验证；
prepare 前的异常可 rollback draft。prepared commit 进入 lifecycle stop/start 后已越过 point of no return，post-commit config/init/drain
failure 只进入结构化 lifecycle report，不把旧 generation 冒充成已回滚的当前状态。

## 生命周期不变量

```text
draft graph -> verify combined required/optional graph -> stop plan -> start plan
            -> host publication -> CommitSummary
```

- provider 启动失败只阻塞 required dependents；optional consumer 走 absent 路径。
- optional provider 的 running generation 出现、消失或 replacement 时，consumer 与其 required dependent closure 在同一
  plan 中最多重启一次；consumer effects 必须在 provider 停止前 drain。
- generation 停止时先关闭 owner invocation gate、abort generation，再 drain effects。
- `init()` 返回的 cleanup/disposable 自动进入当前 effects；正常停止、rollback、replacement、optional restart 与 shutdown
  不调用第二套 teardown hook。
- host 可以在 root 创建前固定提供一个 package-private generation finalizer。它在全部 Part 与 Plugin `init()` 成功后、generation
  进入 running 前执行；它与最终同步 publication callback 共享一个 immutable operation token。finalizer failure 使用普通 start failure、
  dependent blocking 与 effects rollback，不成为新的 Plugin teardown contract。独立 generation 的 finalizer 可以并发，只产出自己的
  host candidate，不能依赖异步完成顺序做跨 owner first-wins 仲裁。
- initial 与 optional availability start wave settle 后，Core 把本 operation 的新 generation 按 provider-first、同 frontier canonical
  node address 的稳定全序交给 package-private async settlement callback，同时提供将撤下的旧 generation Context。host 可以按 Context
  返回 rejection；Core 把它记录为 `start-failed`、drain/delete required dependent closure，并重启 optional ordering closure。重启产生的
  candidate 会再次 settlement，直到没有未 settle generation；普通 collision 不得推迟到最终 publication callback。
- 全部 start outcome 确定后，Core 在 `_lastCommit`、instance watcher、commit listener 与 `CommitSummary` 可见前调用一次 package-private
  async commit preparation，再把同一个 frozen publication fact 交给同步 publication callback。输入只包含本次 `started`、`stopped` 与
  未进入 running 的 `failed` generation facts；preparation 构造最终 immutable host state，publication 只交换已准备好的 pointer 并返回
  `undefined`。任一 callback throw 都是 post-point-of-no-return host invariant failure：原错误向 commit 返回，不伪装成 lifecycle issue、
  不发布 summary，并禁止该 root 继续提交。
- abort/timeout 后迟到的 `init()` fulfillment 不会重新发布 running；迟到返回的 cleanup 会立即执行。
- lifecycle report 是事实源，宿主基于它制定退出、告警或降级策略。

generation construction 通过同步 construction stack 把 node Context 注入原始 implementation；default 与 fork 都以同一个
implementation 作为 `new.target`，不创建 subclass。root constructor 只消费自己有序的 direct requirements；provider factory 按
aggregated graph requirements 建立只读 requirement-to-running-provider map。Part construction frame 创建 child Context 后，按当前 Part
definition 的 direct requirements 从该 map 取得 scoped facade；resolver 不能查询 catalog、动态加载或绕过 committed override。

required 与 optional dependency 共用 scoped consumer Context/provider generation pair cache 的 caller facade；root 与不同 Part occurrence
因此得到不同 facade，但委托同一个 raw provider generation，同一 occurrence 的 required/optional request 可以复用。普通作者字段读写
委托 raw provider，method/getter receiver 保持 caller Context。旧 facade 的 method/getter/write 都经过 provider 与 consumer generation
admission gate，任一侧 replacement 后不能调用旧 generation。Core internal state mutation fail-fast；Plugin inheritance 中的 ECMAScript
`#private` 由 semantic pass 拒绝。

## 内部组成与事件

简单内部拆分使用普通 class/function 与 `ctx.effects.scope()`。同时需要自己的 config slice、effects scope、nested
composition 或 owner-bound capability registration 时使用 `PluginPart`；它是 generation-local containment，不是第二张 graph。
Part constructor 可以就地声明 required Plugin；definition facts 保留每个 Part 的参数顺序，owner graph 则对 root + reachable Part
requirements 去重。一个 provider override 作用于该 owner 的全部消费 occurrence；Part 没有独立 selection、blocked 或 running 状态。
Core 用 module-private occurrence state 保存 Part 的 child Context、immediate host、`partPath` 与 author DSL runtime；Context shape 不包含
occurrence attribution，也没有可供业务代码读取的替代 path/id。`PluginPart.ctx/host/parts/plugins/configs` 与
`BasePlugin.parts/plugins/configs` 只对 subclass 可见，`BasePlugin.ctx` 仍是 provider 的 public caller/inspection contract。
Part child Context 的 service view 惰性缓存，不回灌共享 service 的 mutable `ctx`；Part dependency facade 把 caller scope 与 `partPath`
传播给 provider，未声明 owner binding 的 service 保持 owning Plugin view，root service 原样共享。Part constructor、`init()` 或 cleanup
失败都归入 owning Plugin lifecycle report 并携带 `partPath`；owner teardown 统一关闭所有 Part admission 并 drain generation effects。
需要独立失败传播、启停、replacement 或治理的组成成为 Plugin。

跨 Plugin dependency edge 公开的固定事件集合使用具名 `EvtChannel` 属性；无需 graph dependency 的 host 广播使用
module-augmented `ctx.events`，其订阅绑定 owner effects。Core lifecycle 和 route invalidation 使用明确的 internal subscription，
不进入作者可扩展的 ambient event vocabulary。

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
