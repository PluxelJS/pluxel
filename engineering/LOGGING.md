# Logging Architecture

本文记录 Pluxel 当前日志模型、性能约束和实现入口。插件作者用法见
[`docs/reference/plugin-best-practices.md`](../docs/reference/plugin-best-practices.md)；本文面向维护者和宿主实现。

## 模型

`RuntimeLogging` 拥有唯一 active rootId、LogTape installation、routes/sinks、plugin policy、debug matcher、持久化与 stores。`ContextLogger` 只固定 Context identity、properties 并委托 LogTape。

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

作者调用见 [日志指南](../docs/runtime/logging.md)。

约束：

- `LoggerService` 是 plugin-isolated Context service，不共享可变的 current Context；
- service 只在首次访问 `ctx.logger` 时实例化；
- 六个 level method 位于 prototype，不为每个插件创建六个 closure；
- 一个 `ContextLogger` 只创建一次 category 和 LogTape logger view；
- `getDebugChannel()` 不维护 per-plugin topic cache，调用者需要长期复用时自行保存返回值；
- caller 不在 author facade 捕获，避免 rejected record 产生 stack 成本；
- unmanaged core Context 使用 WeakMap-backed local rootId，但不会被 managed runtime root 接受。

## RuntimeLogging lifecycle

Host 使用 `@pluxel/services/logging` 的 `logging(plan, { policyStore })` descriptor。声明阶段不做 IO；Core 先创建 root，service capability 使用已有 root logger identity 创建 manager。Host prepare 顺序如下：

```text
1. 安装 LogTape config，绑定已有 Context root
2. 初始化持久化 plugin policy
3. 后续服务准备完成，启动 plugin graph
4. 关闭时先停止 plugin graph/effects
5. 释放 root binding，flush policy 和 sinks，释放 LogTape 安装与 process dispose hook
```

Logging 的安装与关闭均归 Host service plan 所有。Core root 创建到 Logging prepare 之前的日志不承诺被此 sink 捕获。

需要 silent logging 时显式安装无 sinks/routes 的 plan；省略 Logging 服务与安装 silent manager 是不同的资源选择。

`RuntimeLogging` 拒绝已有 foreign LogTape config，不静默复用或重置其他 owner 的配置。

## Routes and sinks

Logging plan 显式声明 root policy、physical sinks 与 runtime/plugins/debug/meta 四个 family routes；完整配置 shape 以[日志指南](../docs/runtime/logging.md)为准。

内建 sink：

- console：pretty/text/json；
- file：daily rotating text/jsonl；
- store：bounded in-memory runtime log stream；
- logtape：host 提供的 raw `Sink`。

pretty console 对 trace/debug/info 保持单行；warning/error/fatal 会在下一行展开非保留 structured
properties，因此插件启动失败的 `error`、`cause` 和 lifecycle diagnostics 会直接包含在终端输出中。`context`、
plugin identity 和 caller 等宿主保留字段仍由 category/专用 caller 展示负责，不重复打印。

等级属于 route，不属于 physical sink。同一 console 可以对 runtime 使用 `info`、对 plugins 使用 `trace`。

固定处理顺序：

```text
LogTape family lowestLevel
  -> active root/plugin/debug filter
  -> route minLevel
  -> optional caller enrichment
  -> sink formatting/serialization
  -> physical output
```

physical sink 每个 id 只创建一次；family route wrapper 不拥有第二份资源。structural config 安装后不可热修改。

`servicesPreset` 默认加入有界 store sink，Management 与控制台在关闭 Workbench 时仍可查询日志。自行组合 Host 时由显式 logging plan 选择是否存储。`RuntimeLogStoreRegistry` 自身也是惰性创建；没有 store
route、日志 API 访问或显式 `logging.stores` 访问时不分配 registry/map。

## Dynamic plugin policy

Policy 使用 v3 structured node owner 与 default/override level（含 `off`）。热状态只有 canonical owner key 到 numeric rank 的 Map。

plugin filter 在 rootId 检查后执行一次 `Map.get()` 和数值比较，不读取 properties、不生成 snapshot，也不重新
configure LogTape。

category 第一次进入 filter 时严格解析 route segments；同一个 immutable logger category 的解析结果通过 `WeakMap` 复用，policy
对 frozen address 的 rank lookup 同样弱缓存。任何 policy mutation 都替换 rank cache，因此稳定流不重复 decode/hex encoding，缓存也
不会保活 logger、Plugin 或 category。

route threshold 是宿主硬下限，plugin policy 是动态下限。要让 Workbench 能完整调整
`trace/debug/info/...`，plugins route 必须配置为 `trace`；`servicesPreset` 默认使用这一设置。

mutation 规则：

- default/plugin set、clear 是 O(1)；
- mutation 返回 compact `{ revision, persistence }`，不复制全部 overrides；
- `getPolicy()`、reset、replace 和 persistence snapshot 才是 O(N)；
- RPC 使用 `expectedRevision` 防止并发覆盖；
- persistence save 串行执行并合并中间状态；
- 最多 100,000 个 overrides；每个 owner address 都经过严格 schema validation 和 canonical key 编码；
- `off` 使用专用 numeric rank，不在热路径使用 nullable/string comparison。

policy persistence 接收显式 `PluginLogPolicyStore`；`createPluginLogPolicyStore(namespace)` 借用文档存储，不关闭后端。`servicesPreset` 组合层借用持久化 backend 的 `logger` namespace，没有 module-level singleton。Host 删除 fork 在同一 exclusive queue 中调用已安装服务的 metadata cleanup，policy flush 失败保留 fork 供重试。reader/writer 只接受 v3 structured owner；其他版本直接拒绝，不做 owner 转换或写回。

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
`ctx.elysia` 是业务 ingress，不拥有 store、Management principal 或 Runtime session epoch，不能成为日志 fallback 或第二条
控制通道。长期归档由 file/OTel sink 负责；当前不提供 HTTP archive/download API。

`RuntimeLogLine` 是 UI/transport projection，保留 category、plugin/context identity、structured message、props 和
error summary。它不是新的 author-facing LogRecord。

## 性能验证

热路径不做 caller capture、properties 求值、snapshot、序列化或持久化；单 owner policy lookup 为 O(1)。Snapshot/reset/replace/persistence 是显式 O(N) 操作。Lazy logger、prototype methods、无 per-topic cache 与 bounded store 限制常驻成本。

`packages/services/bench/logger.bench.ts` 对比普通与 100,000 overrides hit，检查规模增长下的 lookup 趋势；单机绝对 ops/s 不是跨环境承诺。

## Package boundaries

```text
@pluxel/core
  ContextLogger, LoggerService, category identity, pure Plugin labels

@pluxel/services/logging
  HostService descriptor, RuntimeLogging manager, policy/stores/sinks

@pluxel/services/logging/protocol
  Browser-safe log DTOs and filters

@pluxel/services/logging/internal
  RuntimeLogging installation and active owner binding

@pluxel/host + @pluxel/services
  Host shutdown ownership and official service defaults
```

core 不包含 log formatter、sink、policy persistence、host env resolution 或 LogTape installation。
Logging 是 Services 包内的具体 Host 服务，通过 `/logging` 显式选择。它的 Host 依赖只用于服务声明与生命周期装配；formatter 直接使用 Core 的纯 Plugin label 投影，不读取 Host 内部实现。
公共入口通过 `logging()` 安装、`Logging` capability 访问当前 owner；manager 创建、active owner 查询与 Context binding 仅属于 `/logging/internal` 框架入口。

关键实现入口：

- `packages/core/src/logger/LoggerService.ts`
- `packages/core/src/logger/categories.ts`
- `packages/services/src/logging/logging.ts`
- `packages/services/src/logging/policy.ts`
- `packages/services/src/logging/sink.ts`
- `packages/services/src/logging/store.ts`
- `packages/services/src/management/services/management/RuntimeManagementTarget.ts`
- `packages/host/src/host.ts`
- `packages/host-dev/src/host-vite.ts`

## 不变量

- 不新增第二个 process logging owner；
- 不新增 module-level mutable policy/store singleton；
- 不为每个插件生成 LogTape config；
- 不在 filter 前 capture caller、serialize error 或求值 lazy properties；
- 不用动态 reconfigure 实现 plugin level 修改；
- 不引入通用 policy language、processor chain 或 LogTape config merge framework；
- 不经 `ctx.elysia`、Plugin route 或第二条 live transport 暴露 Runtime logs；
- 修改 category、Context service、Host prepare order或 policy hot path 时，必须同步更新本文件和对应 benchmark/tests。

## Trusted development scripts

`ctx.logger` 是 Core 基础能力；logging backend、policy 与 store 由宿主配置。开启 devConsole 不改变 logging 方案，也不自动增加 bounded store。可信脚本从 `@pluxel/services/logging` 显式 import `Logging`，通过当前借用的 root 解析，调用 `RuntimeLogging.flushStores()` 及已有 store API 读取有界快照。保留 stream 的 retention、epoch 和 gap 语义，不经 `ctx.elysia` 安装日志接口，也不增加远程 live follow 通道。`markLogs/readLogs/waitForLogs` 由 Logging 领域提供；JSON cursor 绑定 rootId、streamId、bootId 和 epoch，不把 Host replacement 或 retention gap 静默当作连续日志。wait 要求调用方 signal，完成或取消后撤销订阅，不拥有日志生产者。所有权及执行边界见 [`DEV_CONSOLE.md`](DEV_CONSOLE.md)。
