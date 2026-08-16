# Logging Architecture

本文记录 Pluxel 当前日志模型、性能约束和实现入口。插件作者用法见
[`user-docs/plugin-best-practices.md`](../user-docs/plugin-best-practices.md)；本文面向维护者和宿主实现。

## 模型

Pluxel 日志只有两个所有者层级：

```text
RuntimeLogging                 进程级唯一 owner
  ├─ active rootId
  ├─ LogTape installation
  ├─ family routes and sinks
  ├─ plugin policy
  ├─ debug matcher
  ├─ policy persistence
  └─ runtime log stores

ContextLogger                  Context-owned author capability
  ├─ immutable root/plugin identity
  ├─ bound context properties
  └─ LogTape method delegation
```

一个进程只允许一个 active root runtime，因此不需要 `Map<scopeId, LoggingScope>`。第二个
`RuntimeLogging.install()` 会失败；旧 Context 或错误 rootId 产生的 record 会被 active root filter 拒绝。

这个限制同时简化正确性和性能：

- 没有 process-global scope registry 查询；
- 没有多个 LogTape config 的合并、lease 或引用计数；
- policy、debug matcher 和 store ownership 都只有一个事实源；
- launcher shutdown 可以直接按 root 生命周期 flush 和 dispose。

## Category identity

路由身份编码在 category，不依赖可覆盖或 lazy 的 properties：

```text
runtime
["pluxel", "runtime", rootId]

plugin
["pluxel", "plugins", rootId, entryKind, entryLocator, rootExportName, instance, ...forkId]

runtime debug
["pluxel", "debug", rootId, "runtime", ...topicSegments]

plugin debug
["pluxel", "debug", rootId, "plugin", entryKind, entryLocator, rootExportName, instance, ...forkId, ...topicSegments]
```

`entryKind + entryLocator + rootExportName + instance/forkId` 是 `PluginNodeAddressSnapshot` 的 category 投影。
`displayName` 和 `properties.context` 只用于展示和查询。root/plugin identity 与 debug topic 不允许通过 `with()` 或
单次日志 properties 修改。

category builders/parser 位于：

- `packages/core/src/logger/categories.ts`
- `packages/core/src/logger/LoggerService.ts`

## ContextLogger

插件和 runtime 代码只使用：

```ts
ctx.logger.info('started', { port })
ctx.logger.with({ requestId }).warn('retrying')
ctx.logger.getDebugChannel('cache:lookup').debug('cache miss', { key })
```

约束：

- `LoggerService` 是 plugin-isolated Context service，不共享可变的 current Context；
- service 只在首次访问 `ctx.logger` 时实例化；
- 六个 level method 位于 prototype，不为每个插件创建六个 closure；
- 一个 `ContextLogger` 只创建一次 category 和 LogTape logger view；
- `getDebugChannel()` 不维护 per-plugin topic cache，调用者需要长期复用时自行保存返回值；
- caller 不在 author facade 捕获，避免 rejected record 产生 stack 成本；
- unmanaged core Context 使用 WeakMap-backed local rootId，但不会被 managed runtime root 接受。

## RuntimeLogging lifecycle

static/dynamic launcher 使用 `@pluxel/runtime/internal` 安装 manager。标准顺序是：

```text
1. resolve RuntimeLoggingInput
2. create RuntimeLogging
3. install LogTape config
4. bind rootId into Context logger config
5. create Context
6. await config/persistence readiness
7. initialize persisted plugin policy
8. install control plane and start plugin graph
9. stop plugin graph/effects
10. flush policy、reset LogTape，并释放 LogTape 安装的 process dispose hook
```

`logging: false` 表示安装一个无 sinks/routes 的 silent root，不表示跳过 manager。这样 root identity、policy
ownership 和 shutdown 语义不会因为输出关闭而分叉。

`RuntimeLogging` 拒绝已有 foreign LogTape config，不静默复用或重置其他 owner 的配置。

## Routes and sinks

`RuntimeLoggingInput` 由一个 root、显式 sinks 和四个 family routes 组成：

```ts
type RuntimeLoggingInput = {
	root: {
		profile: string
		initialPluginPolicy?: PluginLogPolicySnapshot
		debugTopics?: readonly string[]
		policyLoadFailure?: 'warn' | 'fail'
	}
	sinks: Record<string, RuntimeLoggingSinkInput>
	routes: {
		runtime: readonly RuntimeLoggingRouteBinding[]
		plugins: readonly RuntimeLoggingRouteBinding[]
		debug: readonly RuntimeLoggingRouteBinding[]
		meta: readonly RuntimeLoggingRouteBinding[]
	}
}
```

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

默认 launcher 仅在 Workbench enabled 时加入 store sink。`RuntimeLogStoreRegistry` 自身也是惰性创建；没有 store
route、日志 API 访问或显式 `logging.stores` 访问时不分配 registry/map。

## Dynamic plugin policy

policy snapshot：

```ts
type PluginLogPolicySnapshot = {
	version: 2
	defaultLevel: LogLevel | 'off'
	overrides: readonly {
		owner: PluginNodeAddressSnapshot
		level: LogLevel | 'off'
	}[]
}
```

热状态只有一个 encoded map：

```ts
class RuntimePluginLogPolicy {
	private defaultRank: number
	private ranks = new Map<string, { owner: PluginNodeAddressSnapshot; rank: number }>()

	allows(owner: PluginNodeAddressSnapshot, level: LogLevel): boolean {
		const rank = this.ranks.get(ownerKey(owner))?.rank ?? this.defaultRank
		return rank !== OFF_RANK && LEVEL_RANK[level] >= rank
	}
}
```

plugin filter 在 rootId 检查后执行一次 `Map.get()` 和数值比较，不读取 properties、不生成 snapshot，也不重新
configure LogTape。

route threshold 是宿主硬下限，plugin policy 是动态下限。要让 Workbench 能完整调整
`trace/debug/info/...`，plugins route 必须配置为 `trace`；默认 launcher 使用这一设置。

mutation 规则：

- default/plugin set、clear 是 O(1)；
- mutation 返回 compact `{ revision, persistence }`，不复制全部 overrides；
- `getPolicy()`、reset、replace 和 persistence snapshot 才是 O(N)；
- RPC 使用 `expectedRevision` 防止并发覆盖；
- persistence save 串行执行并合并中间状态；
- 最多 100,000 个 overrides；每个 owner address 都经过严格 schema validation 和 canonical key 编码；
- `off` 使用专用 numeric rank，不在热路径使用 nullable/string comparison。

policy persistence 由 active root 的 `PersistenceService.namespace('logger')` adapter 提供，不存在 module-level
singleton。

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

store 是 runtime API、SSE 和 Workbench log viewer 的事实源，不是 plugin policy 的事实源。

- registry 由 `RuntimeLogging` 实例拥有；
- 默认最多 64 个 physical streams，非 default stream 使用无 subscriber LRU eviction；
- 每个 store 使用 1024-line chunks 和 bounded retention window；
- sink buffer、flush interval、retention、payload caps、hidden/redact keys 都有明确上限；
- plugin node address 从普通/plugin-debug category 解析，不依赖 record properties；
- structured `plugin` filter 直接接受 `PluginNodeAddressSnapshot`；只有非身份用途的 virtual
  `context:<name>` stream 复用 default physical store；
- range/latest/wait/SSE 使用同一 `RuntimeLogStore`。

`RuntimeLogLine` 是 UI/transport projection，保留 category、plugin/context identity、structured message、props 和
error summary。它不是新的 author-facing LogRecord。

## Large-cardinality budget

插件数量增长时，常驻和热路径成本必须按以下规则控制：

| 决策                               | 对大基数的影响                                              |
| ---------------------------------- | ----------------------------------------------------------- |
| 一个 active root                   | 不需要 `Map<scopeId, LoggingScope>` 或每条日志 scope lookup |
| family-level LogTape config        | logger config 数量不随插件数量增长                          |
| category plugin identity           | filter 不读取/求值 properties                               |
| plugin-isolated lazy LoggerService | 从未记录日志的插件不创建 logger service                     |
| prototype level methods            | 每插件不创建六个 method closure                             |
| 无 per-plugin debug cache          | topic 数量不会乘以插件数量形成常驻 Map                      |
| 单一 encoded policy Map            | lookup O(1)，一个 override 一个 Map entry                   |
| compact mutation result            | 单插件调级不会复制 10 万条 overrides                        |
| snapshot/persistence 显式 O(N)     | 线性成本只出现在控制面和持久化，不进入 log hot path         |
| bounded store/chunks               | UI 日志内存由 retention 决定，不由历史总日志量决定          |
| optional/lazy store registry       | headless/Workbench-disabled host 不承担 store 常驻成本      |

`packages/runtime/bench/logger.bench.ts` 同时覆盖普通 override hit 和 100,000 overrides hit。基准用于检查 Map
规模增长是否改变 lookup 复杂度，不把单机绝对 ops/s 当作跨环境承诺。

## Package boundaries

```text
@pluxel/core
  ContextLogger, LoggerService, category identity

@pluxel/runtime/logger
  RuntimeLogging input types, policy/store/protocol stable concepts

@pluxel/runtime/internal
  RuntimeLogging installation, active owner access, persistence adapter

@pluxel/runtime-static / @pluxel/runtime-dynamic
  launcher defaults, boot ordering, shutdown ownership
```

core 不包含 formatter、sink、policy persistence、host env resolution 或 LogTape installation。

关键实现入口：

- `packages/core/src/logger/LoggerService.ts`
- `packages/core/src/logger/categories.ts`
- `packages/runtime/src/logger/logging.ts`
- `packages/runtime/src/logger/policy.ts`
- `packages/runtime/src/logger/sink.ts`
- `packages/runtime/src/logger/store.ts`
- `packages/runtime/src/api/http/rpc/LoggingHandle.ts`
- `packages/runtime-static/src/internal/host.ts`
- `packages/runtime-dynamic/src/hmr/host.ts`

## 不变量

- 不新增第二个 process logging owner；
- 不新增 module-level mutable policy/store singleton；
- 不为每个插件生成 LogTape config；
- 不在 filter 前 capture caller、serialize error 或求值 lazy properties；
- 不用动态 reconfigure 实现 plugin level 修改；
- 不引入通用 policy language、processor chain 或 LogTape config merge framework；
- 修改 category、Context service、launcher boot order或 policy hot path 时，必须同步更新本文件和对应 benchmark/tests。
