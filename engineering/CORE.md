# Core：图、Context 与 generation

`@pluxel/core` 拥有 Plugin definition/node、DI graph、Context projection 和 generation lifecycle，固定提供 FS 与 TinyBase。通用 Context kernel 来自 `@pluxel/context`，在 Core 发布产物中内联。提交状态转换和失败矩阵见[生命周期语义](CORE_LIFECYCLE_SEMANTICS.md)。

## 负责

Core 将工具链生成的 frozen candidate 接纳为 immutable definition/node record，维护 monotonic definition revision、default/fork、provider default、dependency override 和原子 graph commit。启动按 provider-first，停止按 consumer-first，结果进入 `CommitSummary`。

每个 generation 拥有 instance、Context、caller facade、admission gate 和 effects。Core 还拥有 Part containment、constructor requirement lifting、composite config、init-time optional resolution 及内部 commit subscription。FS、TinyBase 和所选日志的资源规则分别见 [FS](FS.md)、[TinyBase](TINYBASE.md)、[Logging](LOGGING.md)。

## 不负责

catalog 来源、配置层合并与保存策略由 Host 拥有；HTTP、RPC 等能力由 Services 拥有；源码发现、编译和 HMR 由工具链与 Host-vite 拥有。optional integration 只观察已有 catalog。安装、重试、进程退出和部署策略均由宿主选择。

## Context capability kernel

`createContextHost()` 把 opaque capability installations 编译成固定 shape。standalone host 可在 root 创建前组合能力，或通过 `overrides` 替换同一 descriptor；override 保持 scope 和 projected property。编译后 shape 不再改变。

Core 把 kernel scope 映射到 Plugin 生命周期：

| Kernel scope | Backing identity            | Core 投影                               |
| ------------ | --------------------------- | --------------------------------------- |
| root         | 每个 root 一份              | root property；显式 resolve 可共享      |
| scope        | 每个 Plugin generation 一份 | Plugin、Part、caller view 共享          |
| owner-view   | root backend 一份           | Plugin、Part、caller edge 各自缓存 view |

创建 host/root/scope/child 不调用 capability factory。首次读 property 或显式 `resolveContextCapability()` 才构造值，成功值按 scope 缓存。kernel 保持同步、host-neutral；IO prepare/dispose 由上层拥有。业务 Plugin 通过 graph 表达依赖，模块求值、`init()` 和 route 均不能追加 Context capability。

plan-local prototype getter 直接调用预编译 resolver、读取 dense array slot；缓存读取不做 Map/string lookup、scope branch 或闭包分配。descriptor identity Map 只用于 compile 和显式 resolve。`Object.create(null)` 无法代替 object identity 映射；探针见 `packages/context/bench/context.bench.ts`。

factory closure 捕获本 host 已解析、冻结的输入，Context 不暴露 host config。caller-derived view 共享 provider root/generation backing，独立缓存 owner view 并固定 readonly caller pin；caller 不是 containment parent，并发冷访问保持归属独立。

Core effects/commit hooks 管理固定 FS/TinyBase：首次文件操作准备 IO，generation publication 开启自动保存，最终先关闭日志、再关闭 TinyBase、最后关闭 FS。Host 自动等待 `prepareCoreContext(root)`；Core-only 嵌入者在启动 Plugin 前显式等待它。Host config/state 文档在 Plugin admission 前恢复，显式服务使用自己的 prepare 阶段。

源码通过 `devDependencies: workspace:*` 引用 Context，tsdown `alwaysBundle` 内联 JS 与 declarations。Core 消费者无需另装 Context；standalone Context 用户单独依赖该包。registry 属于 evaluated module instance，Core 内联 kernel 与 standalone kernel 可共存，但 descriptor、installation、plan 和 Context 不能跨 kernel 传递。开发期同包 identity 由 HMR bridge 保持。

## Identity 与 DI 不变量

身份与 codec 由 [Plugin Identity](PLUGIN_IDENTITY.md) 维护。Core intern address 后以 slot object 查图；展示名称和 constructor object 不作 graph key。

required edges 只来自 semantic lowering 的 constructor value-import provenance。root direct requirements 保持参数顺序，reachable Part requirements 按 definition 聚合到 owner graph；Part 不创建 node。optional edges 只来自 lowered module-level、non-exported `definePluginRef<T>()`，同样聚合到 owner。

`isRunning/getInstance/resolvedDependencies/resolvePluginNode/isMaterialized/watch` 使用 non-creating lookup；未知地址、constructor 或拒绝的 restart/remove/binding 不留下 slot。只有 materialize 和显式 internal intern 创建 slot。未 lowering 的 Plugin 明确失败。

## Definition、node 与 generation

- `ConcretePluginDefinitionRecord` 固定 candidate revision 的 implementation、schema、有序 constructor requirements、聚合 edges、Part tree、provider relation 和 forkable；abstract token 没有 record。
- `PluginNodeRecord` 固定 default/fork address 并引用 definition record；尚未 materialize 的 durable fork 不产生 Core record。
- generation 是该 node 的一次运行，包含 instance、Context、facade、gate 和 effects，不参与 address。

definition/node slots 在 Host 内稳定。replacement 原子创建新 definition record，通过 definition-to-materialized-node index 以 O(k) 更新其 node family。没有 fork 且不在 effective desired graph 的 definition 不创建 node/fork table 或 synthetic subclass。

### Graph snapshot 与成本模型

numeric slot identity 在 Host 内 append-only。remove 后保留 tombstone 到 Host dispose，active record、generation、Context、effects 与 caller cache 随资源释放。

immutable snapshot 的 slot table 使用四层、每层 64 路的 radix sharing。draft 是 immutable base 加 sparse delta；commit 只复制变化的 radix path、dependency adjacency 和 token index overlay。cycle/closure/dependent traversal 使用 epoch marks 和 sparse queue，固定 k replacement 的成本由变化 nodes、影响 edges 与触及页决定，不复制全图或按 slotCount 分配临时数组。

`GraphSnapshot` 和 radix/tombstone layout 是内部表示。公共 `CommitSummary` 投影 `pluginChanges`、`lifecycleReport` 与 `runtimeUpdate.reason`；只有内部 watcher 接收 committed graph。

成本回归位于 `PluginDefinitions.cost-model.test.ts`、`PluginService.cost-model.test.ts` 和 internal DI tests。趋势探针：

```sh
vp run @pluxel/core#bench:caller-view
vp run @pluxel/core#bench:fork-cost
vp run @pluxel/context#bench
```

保持 absent read 零物化、family 枚举 O(k)、固定 k update 不扫描无关 graph、remove 只保留 identity tombstone。绝对延迟随环境变化。

`prepare()` 校验 candidate/address、forkability、binding、combined graph 和 affected closure，拒绝时可丢弃 draft。进入 lifecycle stop/start 后，config/init/drain 失败进入 report，已关闭的旧 generation 保持退役。

## 生命周期与 caller facade

finalizer、settlement、publication、late init 和 effects 的完整顺序见[生命周期语义](CORE_LIFECYCLE_SEMANTICS.md)。Host 发布前先准备完整 immutable state，再同步交换 pointer。

每个 generation actor 拥有 Context、queue 和 subscription，共用紧凑整数转移表，快照和错误使用具名状态。START/STOP 串行接纳；STOP 接纳时立即 abort init 并启动同一 drain。异步效果结算后发布快照，订阅安装期间排队的错误先于稳定启动结果结算。停止的 actor 为终态；restart 创建新 generation。初始已结算 Promise 可共享，排队后的链各自独立。

同步 construction stack 向原始 implementation 注入 node Context。default/fork 的 `new.target` 相同。root constructor 只取有序 direct requirements；provider factory 从聚合 graph 建立只读 requirement-to-running-provider map。Part frame 创建 child Context，按其 direct requirements 取 facade，不查询 catalog、加载代码或绕过 committed override。

required/optional 请求共用以 consumer Context/provider generation 为 key 的 facade cache。同一 occurrence 可复用，不同 root/Part occurrence 各有 facade，底层委托同一 raw provider。method/getter invocation 的独立 receiver 固定 caller Context，field 读写委托 raw provider，保持单一状态。method/getter/write 均检查 provider 和 consumer admission，任一 generation 撤回后旧 facade 失效。

provider construction 后一次编译 fields/prototype surface，保持 non-extensible、non-configurable shape。跨节点 callable 使用 prototype method；accessor 返回普通数据或自带 receiver/withdrawal 规则的 object handle。动态新增字段不能成为 dependency surface，Core internal mutation 明确拒绝。

semantic pass 拒绝以下 Plugin inheritance 成员：

| 成员                           | 原因                            | 诊断                                            |
| ------------------------------ | ------------------------------- | ----------------------------------------------- |
| instance `#private`            | facade 无法通过原生 brand check | `plugin_caller_view_private_brand_unsupported`  |
| function-valued instance field | 固定 construction receiver      | `plugin_caller_view_callable_field_unsupported` |
| type-only `declare` field      | 缺少 construction-time shape    | `plugin_caller_view_declared_field_unsupported` |

运行期 callable field/accessor result 同样拒绝。普通 TypeScript `private` 和不经 dependency facade 的 Part 不受 private-brand 限制。

## 内部组成与事件

普通拆分用 class/function，单组 cleanup 用 `ctx.effects.scope()`；同时需要 config slice、owner-bound capability 或嵌套组成时使用 `PluginPart`。独立启停、失败传播、replacement 或治理使用 Plugin。

Part 是 generation-local containment。definition 保留各 occurrence 的 direct requirement 顺序，owner graph 对 root/Part requirements 去重；provider override 作用于全部 occurrence。Part 没有独立 selection、blocked 或 running 状态。

module-private occurrence state 保存 child Context、immediate host、partPath 和 DSL runtime。Context shape 不增加归属字段。Part 的 `ctx/host/parts/plugins/configs` 与 BasePlugin 的组成 DSL 只对 subclass 可见，`BasePlugin.ctx` 保留 public caller/inspection 用途。child service view 惰性缓存，已绑定 owner 的 service 使用 Part view，其余保持 owning Plugin view，root service 原样共享。dependency facade 向 provider 传播 caller scope 和 partPath。Part constructor/init/cleanup 失败归入 owner lifecycle report 并带 partPath；teardown 关闭全部 Part admission，统一 drain generation effects。

固定 dependency 事件使用具名 `EvtChannel` 属性；无需 graph dependency 的广播使用 module-augmented `ctx.events`，订阅绑定 owner effects。Core lifecycle/route invalidation 使用专门内部 subscription。

## 实现入口

- `packages/core/src/plugins/runtime/{identity,definition,part-definition}.ts`、`toolchain.ts`：声明与身份。
- `packages/core/src/internal/di/`、`plugins/runtime/PluginService.ts`：graph 和 commit。
- `packages/core/src/plugins/runtime/PluginActor.ts`、`plugin-service/LifecycleManager.ts`：generation 状态。
- `packages/core/src/plugins/composition/`，尤其 `caller-view.ts`：construction、Part、caller surface。
- `packages/core/src/services/effects/EffectsService.ts`、`services/config/`：effects 和配置。

普通 Plugin 回归使用 `@pluxel/test` 并显式选择 services；图语义白盒使用 `@pluxel/core/internal/test`。测试 Plugin 仍经过 semantic lowering，unsafe facts helper 仅用于明确的内部测试。
