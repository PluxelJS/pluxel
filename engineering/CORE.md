# Core：图、Context 与 generation

`@pluxel/core` 拥有 Plugin definition/node、DI graph、Context 与 generation lifecycle，固定提供 FS、TinyBase 与 Vault。通用 Context kernel 来自 `@pluxel/context`，在 Core 发布产物中内联。提交状态转换和失败矩阵见[生命周期语义](CORE_LIFECYCLE_SEMANTICS.md)。

## 负责

Core 将工具链生成的 frozen candidate 接纳为 immutable definition/node record，维护 monotonic definition revision、default/fork、provider default、dependency override 和原子 graph commit。启动按 provider-first，停止按 consumer-first，结果进入 `CommitSummary`。

每个 generation 拥有 instance、Context、caller facade、admission gate 和 effects。Core 还拥有 Part containment、constructor requirement lifting、composite config、init-time optional resolution 及内部 commit subscription。FS、TinyBase 和所选日志的资源规则分别见 [FS](FS.md)、[TinyBase](TINYBASE.md)、[Logging](LOGGING.md)。

## 不负责

catalog 来源、配置层合并与保存策略由 Host 拥有；HTTP、RPC 等能力由 Services 拥有；源码发现、编译和 HMR 由工具链与 Host-vite 拥有。optional integration 只观察已有 catalog。安装、重试、进程退出和部署策略均由宿主选择。

## Context service kernel

Core 直接提供固定的 `ctx.logger`、`ctx.effects`、`ctx.events`。Plugin Context 另有 `ctx.fs()`、`ctx.tinybase`、`ctx.vault`、`ctx.wretch` 和 `ctx.fetch`。配置日志后，根 Context 提供 `root.logging`。这些固定能力由 Core 构造、缓存并管理生命周期。 [出站 HTTP](OUTBOUND_HTTP.md)

Core 的组合入口是 `createCoreContextHost()`：它固定内建能力，并将应用选择的 `services` 交给 Context kernel 编译。Pg、HTTP、Workbench 等由应用显式安装，插件通过 `ctx.service()` 声明对它们的依赖。required 声明直接使用普通 class 或 abstract class；`defineServiceRef<T>()` 是指向同一声明的 optional 引用，由源码工具链从具名导入生成。Pluxel 的跨编译身份来自 canonical entry + exportName，standalone kernel 也可直接以声明对象作为进程内 key。没有手写 service ID、property projection 或运行期安装入口。

`CoreFacilitiesConfig` 统一声明 LogTape、ZenFS、TinyBase、Vault、出站 HTTP 与 events。直接创建 Core 时将这些字段和 `name`、`execution` 一起传入。应用 Host 在处理部署输入前调用 Core 校验并快照 `coreConfig`，编译 Context 时使用该快照。配置捕获保留原生 callback 与借用资源的引用，资源获取由各设施的准备阶段负责。

`ctx.service(Declaration)` 返回 T，未安装抛出 `ContextServiceMissingError`；`ctx.service(ref)` 返回 T | undefined，仅缺失返回 undefined。声明与安装访问权限都要通过校验，access、construction、stale contract 错误不能被可选引用吞掉。

Core 将 kernel 缓存范围映射到 Plugin 生命周期：

| Kernel scope | Backing identity            | Core 归属                               |
| ------------ | --------------------------- | --------------------------------------- |
| root         | 每个 root 一份              | 仅真实 root 直接读取                    |
| scope        | 每个 Plugin generation 一份 | Plugin、Part、caller view 共享          |
| owner-view   | 每个 root 一份 backend      | Plugin、Part、caller view 各自缓存 view |

`all`、`root`、`owner` 表达访问约束，root 安装始终额外要求真实根 Context。声明的 `static readonly access` 提供类型约束，安装器固定运行期约束。创建 host/root/scope/child 不调用服务工厂；首次 `ctx.service()` 才同步构造，成功值按 scope 缓存。服务查找先按声明 key 选择预编译 resolver，再读取 dense array slot；kernel 不接管异步 IO 或资源关闭。`overrides` 只在创建 host 时替换同一声明、scope 和 access，不改变已编译集合。

factory closure 捕获本 host 已解析、冻结的输入，Context 不暴露 host config。caller view 共享 provider root/generation backing，独立缓存 owner view 并固定 readonly caller pin；caller 不是 containment parent。PluginPart 的 child Context 直接持有该 Part 的 effects 子作用域和带 partPath 的 logger，caller view 保留这些归属。内建能力的构造由 Core 负责，服务安装集合与访问权限始终固定。

Core effects/commit hooks 管理固定 FS、TinyBase 与 Vault：首次操作按需准备 IO，generation publication 开启 Store 自动保存；根关闭时排空已接纳操作，先释放上层能力，再关闭文件系统。Host 自动等待 `prepareCoreContext(root)`；Core-only 嵌入者在启动 Plugin 前显式等待它。Host config/state 文档在 Plugin admission 前恢复，显式服务使用自己的 prepare 阶段。

源码通过 `devDependencies: workspace:*` 引用 Context，tsdown `alwaysBundle` 内联 JS 与 declarations。Core 消费者无需另装 Context；standalone Context 用户单独依赖该包。registry 属于 evaluated module instance，Core 内联 kernel 与 standalone kernel 可共存，但 installation、plan 和 Context 不能跨 kernel 传递。开发期同包 identity 由 HMR bridge 保持。

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

Internal DI 回归验证提交后的图快照和深链行为。扩展成本通过以下基准测量。

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

Core 开始 generation 时先取 Host 按节点声明的 `startTimeoutMs`，再取该代定义元数据中的期限，最后使用已经绑定的 Host 执行期限或 Core 默认值。显式期限为 1 至 2,147,483,647 的整数毫秒。Core 在提交 START 前选定该代期限，生命周期回执记录超时采用的毫秒数。`startConcurrency`、`stopConcurrency` 与 `drainTimeoutMs` 属于整个 Host。

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

普通拆分用 class/function，单组 cleanup 用 `ctx.effects.scope()`；同时需要 config slice、owner-bound service 或嵌套组成时使用 `PluginPart`。独立启停、失败传播、replacement 或治理使用 Plugin。

Part 是 generation-local containment。definition 保留各 occurrence 的 direct requirement 顺序，owner graph 对 root/Part requirements 去重；provider override 作用于全部 occurrence。Part 没有独立 selection、blocked 或 running 状态。

module-private occurrence state 保存 child Context、immediate host、partPath 和 DSL runtime。Context shape 不增加归属字段。Part 的 `ctx/host/parts/plugins/configs` 与 BasePlugin 的组成 DSL 只对 subclass 可见，`BasePlugin.ctx` 保留 public caller/inspection 用途。owner-view 按 Part Context 惰性缓存，scope service 保持 owning Plugin generation backing，root service 保留根访问限制。dependency facade 向 provider 传播 caller scope 和 partPath。Part constructor/init/cleanup 失败归入 owner lifecycle report 并带 partPath；teardown 关闭全部 Part admission，统一 drain generation effects。

固定 dependency 事件使用具名 `EvtChannel` 属性；无需 graph dependency 的广播使用 module-augmented `ctx.events`，订阅绑定 owner effects。Core lifecycle/route invalidation 使用专门内部 subscription。

## 实现入口

- `packages/core/src/plugins/runtime/{identity,definition,part-definition}.ts`、`toolchain.ts`：声明与身份。
- `packages/core/src/internal/di/`、`plugins/runtime/PluginService.ts`：graph 和 commit。
- `packages/core/src/plugins/runtime/PluginActor.ts`、`plugin-service/LifecycleManager.ts`：generation 状态。
- `packages/core/src/plugins/composition/`，尤其 `caller-view.ts`：construction、Part、caller surface。
- `packages/core/src/services/effects/EffectsService.ts`、`services/config/`：effects 和配置。

普通 Plugin 回归使用 `@pluxel/test` 并显式选择 services；图语义白盒使用 `@pluxel/core/internal/test`。测试 Plugin 仍经过 semantic lowering，unsafe facts helper 仅用于明确的内部测试。
