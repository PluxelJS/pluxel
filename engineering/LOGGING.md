# 日志：身份、策略与有界读取

本文记录 Pluxel 当前日志模型、性能约束和实现入口。插件作者用法见
[`docs/plugin-development/logging.md`](../docs/plugin-development/logging.md)；本文面向维护者和宿主实现。

修改身份/归属读 [Category identity](#category-identity) 与 [ContextLogger](#contextlogger)；修改安装或输出读 [RuntimeLogging lifecycle](#runtimelogging-lifecycle) 与 [Native LogTape configuration](#native-logtape-configuration)；修改在线级别读 [Dynamic plugin policy](#dynamic-plugin-policy)；修改读取/游标读 [Runtime store](#runtime-store)。

## 模型

`RuntimeLogging` 拥有唯一 active rootId、LogTape installation、原生 configuration、plugin policy、debug matcher、持久化与 stores。`ContextLogger` 只固定 Context identity、properties 并委托 LogTape。

一个进程只能有一个 active logging root。第二次 install 或已有 foreign LogTape config 都失败；失败候选清理不能 reset 原 owner。旧 Context/错误 rootId 的 record 被 active-root filter 拒绝。Host 关闭负责 flush/dispose，无额外 scope registry、config merge 或引用计数。

## Category identity

路由身份编码在 category，不依赖可覆盖或 lazy 的 properties：

```text
runtime
["pluxel", "runtime", rootId]

plugin
["pluxel", "plugins", rootId, ...v1NodeRouteSegments]

runtime debug
["pluxel", "debug", rootId, "runtime", ...topicSegments]

plugin debug
["pluxel", "debug", rootId, "plugin", ...v1NodeRouteSegments, ...topicSegments]
```

`v1NodeRouteSegments` 是 Core `formatPluginNodeRoute()` 生成的可读、可逆 `PluginNodeAddress` 投影，例如
`v1/fork/east/package/OrdersPlugin/@acme/orders`。它显示 root export/package/source/fork，不包含绝对路径或 opaque digest。
`displayName` 和 `properties.context` 只用于展示和查询。root/plugin identity 与 debug topic 不允许通过 `with()` 或
单次日志 properties 修改。

category builders/parser 位于：

- `packages/core/src/logger/categories.ts`
- `packages/core/src/logger/LoggerService.ts`

## ContextLogger

作者调用见 [日志指南](../docs/plugin-development/logging.md)。

约束：

- `LoggerService` 是 plugin-isolated Context service，不共享可变的 current Context；
- service 只在首次访问 `ctx.logger` 时实例化；
- 六个 level method 位于 prototype，不为每个插件创建六个 closure；
- 一个 `ContextLogger` 只创建一次 category 和 LogTape logger view；
- `getDebugChannel()` 不维护 per-plugin topic cache，调用者需要长期复用时自行保存返回值；
- caller 不在 author facade 捕获，避免 rejected record 产生 stack 成本；
- 每个 root 使用 WeakMap 保存稳定 identity，配置日志前创建的 logger 在配置后仍沿用同一 identity；当前 manager 的 guard 拒绝其它或已退役 root 的记录。

## RuntimeLogging lifecycle

应用在 `runtime.logtape` 直接传原生 Config 或同步 root factory，也可传 `{ input, options }` 表达框架 policy 选项。`logtape()` 是可选预设，`logtape(nativeConfig, options)` 捕获同一声明；没有品牌准入检查。Core 用唯一 root identity 创建 manager。省略 logtape 不安装 manager 或进程 LogTape 配置。

```text
1. 创建 root 与其固定 logger identity
2. Core prepare 安装 LogTape config，绑定当前 root
3. 初始化持久化 plugin policy
4. Host 准备其余服务，再启动 plugin graph
5. 关闭时先停止 plugin graph/effects
6. Core flush stores/policy 与原生 drainable sinks，通过 LogTape reset 等待资源释放
7. 关闭 TinyBase 与 FS
```

生产 Host 自动等待 Core 准备；直接通过 `@pluxel/core/host` 创建 root 的嵌入者，在启动 Plugin 前先 `await prepareCoreContext(root)`。日志安装、关闭和 policy 都归 Core，不再作为 Services descriptor 安装。Core root 创建到 prepare 完成之前的日志不承诺被此 sink 捕获。

需要 silent manager 时显式配置 `logtape({ sinks: {}, loggers: [] })`；省略 `runtime.logtape` 不安装该 manager，仍可调用 `ctx.logger`。

`RuntimeLogging` 拒绝已有 foreign LogTape config，不静默复用或重置其他 owner 的配置。

## Native LogTape configuration

`logtape(nativeConfig, options)` 直接接受固定版本 LogTape 的 `Config<string, string>`。`sinks`、`filters`、`loggers`、`contextLocalStorage` 以及 logger 的 `parentSinks`、`captureSourceLocation` 等字段按上游语义处理；sink/filter/formatter/context storage 保留原对象，不再经过 sink kind、family routes 或逐字段复制的配置语言。完整用法见 [Host 日志配置](../docs/host/configuration.md#host-logging)。

Pluxel 的独立设置只位于 `LoggingOptions`：profile、初始 Plugin policy、debug topics、policy load failure 与可选借用的 policy store。同步 config factory 额外获得 `rootId` 和 `createRuntimeLogSink()`，其唯一职责是把有界 Workbench sink 绑定当前 manager 的 registry/flush 生命周期；factory 在 prepare 中求值一次，返回值仍是完整原生 Config。helper 不能在 factory 返回后继续创建 sink。

`logtape()` 的可选默认预设提供易读 console 与有界 store，默认 profile 为 `pluxel`。应用在 `runtime.logtape` 中选择它；`servicesPreset()` 只返回服务清单，不安装日志。自定义配置完整替换默认输出。Node file、JSON、OTel、redaction、stream 与异步组合均直接使用相应上游 sink/formatter。

### Identity guard and native inheritance

框架只添加一个原生 filter。没有显式根 logger 时添加仅含此 filter 的根配置；已有根 logger 保留其字段并把 guard 放在 filters 首位。对于有非空 `filters` 的其他 logger，也只在原列表前补 guard。其他 logger 保持 `filters` 的省略/空数组状态，因此原生“最近非空祖先 filter”的继承与替换语义不变。guard id 避开用户已提供的 filter 名，不覆盖输入。

此 guard 只对 `pluxel/runtime`、`pluxel/plugins`、`pluxel/debug` 管理类别检查身份、动态 policy 与 topic。普通应用类别与其他库类别原样通过。用户 filter 在 guard 之后执行；native logger 级别、sink 继承、`parentSinks: 'forward'` 以及可选 source location capture 仍由 LogTape 实现，不编译成另一套路由器。

Core 不主动捕获 caller。默认 store 的 caller 丰富化在 guard 与原生 filter 之后进行；用户显式选择 `captureSourceLocation` 时，上游会在其自身调用阶段取 stack，这项成本不承诺由 Plugin policy 提前消除。昂贵属性使用原生 `lazy()`；properties factory 按上游语义可能早于 filter 求值。

### Resource ownership

安装仍拒绝 active RuntimeLogging 或 foreign LogTape owner。原生 `reset: true` 在当前 Host owner 模型下明确拒绝，不能借它接管另一个安装；无字段被静默删除或改成成功。传入原生配置的其他字段以对象展开保留，引用与重复 category 等错误由 LogTape 的原生 `ConfigError` 报告。

`RuntimeLogging.flush()` 刷新 bounded store/policy，并调用原生 `drain()`；只有实现 Drainable 的 sink 会参与 drain。dispose 先等待进行中的 install，包括同步 config factory 内重入关闭，再执行 flush/reset；flush/drain 失败后仍继续 reset，等待所有同步/异步 sink/filter 释放，合并失败后交给 Host。关闭期间持续持有 owner，并拒绝重新安装。只有当前全局配置仍是自身安装对象时才能 reset；外部替换会导致关闭报错并保留 foreign configuration。并发 dispose 共用同一 Promise。

远程输出直接组合原生 LogTape sink 与 OTel SDK，官方装配见 [远程输出](../docs/host/configuration.md#远程输出原生-logtape-sink)。OTel sink 没有原生 drain，运行中立即发送批次仍使用 provider 的 `forceFlush()`；Host close 通过其 async disposal 等待 provider shutdown。`tests/logging/otlp.test.ts` 覆盖 HTTP JSON/protobuf、插件关闭日志与 prepare rollback。

默认 preset 的 console 按 `info` 过滤，store 保留 `trace`，因而 Workbench 可独立调整 Plugin policy。未选择 store 的直接原生配置不会分配 registry；`RuntimeLogStoreRegistry` 仍惰性创建，显式访问 stores 也会创建它。

## Dynamic plugin policy

Policy 使用 v3 structured node owner 与 default/override level（含 `off`）。热状态只有 canonical owner key 到 numeric rank 的 Map。

plugin filter 在 rootId 检查后执行一次 `Map.get()` 和数值比较，不读取 properties、不生成 snapshot，也不重新
configure LogTape。

category 第一次进入 filter 时严格解析 route segments；同一个 immutable logger category 的解析结果通过 `WeakMap` 复用，policy
对 frozen address 的 rank lookup 同样弱缓存。任何 policy mutation 都替换 rank cache，因此稳定流不重复 decode/hex encoding，缓存也
不会保活 logger、Plugin 或 category。

原生 logger/filter threshold 是宿主静态下限，plugin policy 是动态下限。要让 Workbench 能完整调整
`trace/debug/info/...`，接收 Plugin 日志的 logger/store 保持 `trace`；`logtape()` 的默认预设使用这一设置。

mutation 规则：

- default/plugin set、clear 是 O(1)；
- mutation 返回 compact `{ revision, persistence }`，不复制全部 overrides；
- `getPolicy()`、reset、replace 和 persistence snapshot 才是 O(N)；
- RPC 使用 `expectedRevision` 防止并发覆盖；
- persistence save 串行执行并合并中间状态；
- 最多 100,000 个 overrides；每个 owner address 都经过严格 schema validation 和 canonical key 编码；
- `off` 使用专用 numeric rank，不在热路径使用 nullable/string comparison。

`logtape(nativeConfig, { policyStore })` 的 policyStore 接收同步 `(root: RootContext) => PluginLogPolicyStore` factory，在 Core 日志准备中解析一次；省略时使用 `requireHostDocuments(root, 'logging')`。Logging 借用文档存储，不关闭后端；policy candidate 与失败回执由 Logging 维护，普通文档与 final 排空由 [FS](FS.md)维护，路径为 `services/host/logging/plugin-policy/<profile>.json`。Host 删除 fork 在同一 exclusive queue 中清理 Core 日志 policy，再清理服务元数据；policy flush 失败保留 fork。writer 故障须关闭检查实际 backing 后恢复。reader/writer 只接受 v3 structured owner；其他版本直接拒绝，不做 owner 转换或写回。

## Debug topics

debug pattern 是 root structural config：

- `hmr:batch`：exact；
- `hmr:*`：prefix；
- `*`：全部；
- 空数组：全部关闭。

patterns 在 manager 创建时编译，最多 256 条；topic 最多 16 个 segment，每段最多 80 个字符。matcher 直接比较
category segments，不 join string、不读取 properties。

plugin debug 必须同时通过：

1. active rootId；
2. plugin dynamic policy；
3. root debug matcher。

因此把插件设置为 `off` 会同时关闭它的普通日志和 debug channel。

## Runtime store

store 是 Runtime Management API 和 Workbench log viewer 的事实源，不是 plugin policy 的事实源。

- registry 由 `RuntimeLogging` 实例拥有；
- 默认最多 64 个 physical streams，非 default stream 使用无 subscriber LRU eviction；
- 每个 store 使用 1024-line chunks 和 bounded retention window；
- sink buffer、flush interval、retention、payload caps、hidden/redact keys 都有明确上限；
- plugin node address 从普通/plugin-debug category 解析，不依赖 record properties；
- structured `plugin` filter 直接接受 `PluginNodeAddress`；只有非身份用途的 virtual
  `context:<name>` stream 复用 default physical store；
- range/latest/wait/Cap’n Web `follow(observer)` 使用同一 `RuntimeLogStore`。

Workbench 的 bounded range/follow 固定经过页面唯一的已认证 Runtime Cap’n Web session。Plugin generation-scoped
`ctx.require(ElysiaApp)` 是业务 ingress，不拥有 store、Management principal 或 Runtime session epoch，不能成为日志 fallback 或第二条
控制通道。长期归档由 file/OTel sink 负责；当前不提供 HTTP archive/download API。

`RuntimeLogLine` 是 UI/transport projection，保留 category、plugin/context identity、structured message、props 和
error summary。它不是新的 author-facing LogRecord。

## 性能验证

框架身份/policy guard 不做 caller capture、properties 求值、snapshot、序列化或持久化；单 owner policy lookup 为 O(1)。Snapshot/reset/replace/persistence 是显式 O(N) 操作。Lazy logger、prototype methods、无 per-topic cache 与 bounded store 限制常驻成本。

`packages/core/bench/logger.bench.ts` 对比普通与 100,000 overrides hit，检查规模增长下的 lookup 趋势；单机绝对 ops/s 不是跨环境承诺。

## Package boundaries

```text
@pluxel/core
  ContextLogger, LoggerService, category identity, pure Plugin labels

@pluxel/core/config
  logtape() and zenfs() code configuration declarations

@pluxel/core/logging
  Logging root token, RuntimeLogging manager, policy/stores/query

@pluxel/core/logging/protocol
  Browser-safe log DTOs and filters

@pluxel/core/logging/internal
  RuntimeLogging installation, active owner binding and framework helpers

@pluxel/core/logging/pretty
  Optional console presentation with Plugin identity and Context labels

@pluxel/host + @pluxel/services
  Application lifecycle and optional Management projections
```

Core 拥有日志安装、sink、policy 持久化、store 与 query；配置 helper 不依赖 Host 或 Services。Management 从 Core 读取同一个 manager，不能重新安装日志。浏览器协议入口只承载 DTO/filter，不加载 Node 文件 sink 或日志安装后端。pretty 是独立可选叶入口，不经 internal 引入；文件输出直接使用 `@logtape/file`，没有框架 file wrapper。
公共输出通过 `runtime.logtape: logtape(...)` 选择，宿主通过 `Logging` capability 访问当前 owner；manager 创建、active owner 查询与 Context binding 仅属于 `/logging/internal` 框架入口。旧 Services 三个日志入口不保留兼容别名。

关键实现入口：

- `packages/core/src/logger/LoggerService.ts`
- `packages/core/src/logger/categories.ts`
- `packages/core/src/logging/logging.ts`
- `packages/core/src/logging/policy.ts`
- `packages/core/src/logging/sink.ts`
- `packages/core/src/logging/store.ts`
- `packages/services/src/management/services/management/RuntimeManagementTarget.ts`
- `packages/host/src/host.ts`
- `packages/host-vite/src/host-vite.ts`

## 验证

修改 category、Context service、Host prepare order 或 policy hot path 时，覆盖 active root/foreign root 拒绝、缓存 Context 归属、重复安装失败不 reset 原 owner、关闭 flush，以及过滤前不求值 properties/caller。Policy 测试验证 revision、并发写入与串行 persistence；store 测试验证 retention、gap、epoch 和 bounded follow。

原生配置与继承、contexts、独立 Node 调用位置、drain/async disposal 和 foreign owner 由 `tests/logging/native-config.test.ts` 验证；类型示例由同目录 `native-config.typecheck.ts` 验证。直接回归入口为 `packages/core/tests/logging/`；成本变化同时运行[性能验证](#性能验证)中的探针。Logging 不引入通用 policy language、processor chain 或 LogTape config merge framework。

## Trusted development scripts

`ctx.logger` 是 Core 基础能力；logging backend、policy 与 store 由宿主配置。开启 scripts 不改变 logging 方案，也不自动增加 bounded store。可信脚本从 `@pluxel/core/logging` 显式 import `Logging`，通过当前借用的 root 解析，调用 `RuntimeLogging.flushStores()` 及已有 store API 读取有界快照。保留 stream 的 retention、epoch 和 gap 语义，不经 `ctx.require(ElysiaApp)` 安装日志接口，也不增加远程 live follow 通道。`markLogs/readLogs/waitForLogs` 由 Logging 领域提供；JSON cursor 绑定 rootId、streamId、bootId 和 epoch，不把 Host replacement 或 retention gap 静默当作连续日志。wait 要求调用方 signal，完成或取消后撤销订阅，不拥有日志生产者。所有权及执行边界见 [`DEV_CONSOLE.md`](DEV_CONSOLE.md)。
