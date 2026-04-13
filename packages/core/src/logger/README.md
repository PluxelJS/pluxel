# @pluxel/core/logger (LogTape)

`@pluxel/core` 是 **logger 封装与约定**，不是 logger runtime：不会在库内部调用 `configure()`。
宿主（app / CLI / 各类启动入口，例如 `pluxel hmr`）必须显式配置 LogTape。

补充：如果你在使用 `@pluxel/runtime`，也建议宿主在启动入口统一 `configure(createPluxelLogtapeConfig(...))`，
避免分散的“自动配置”导致行为隐式且难以追踪。

调用点约束以 lint 为准：仓库通过 `packages/workspace/src/oxlint/plugin.ts`（对外发布为 `@pluxel/test/oxlint`）强制日志错误字段、禁止错误字符串插值，以及限制直接 `getLogger()` 导入。
其中只有可证明安全的场景会提供 `--fix` / suggestion；涉及错误语义、消息措辞或 logger 上下文改写的场景只保留诊断，不做激进自动修复。

## Categories

- `pluxelCategories.core` → `["pluxel","core"]`
- `pluxelCategories.hmr` → `["pluxel","hmr"]`
- `pluxelCategories.plugins` → `["pluxel","plugins"]`

插件分型不扩 category：统一使用 `["pluxel","plugins"]`，插件身份通过属性携带，便于 filter。

## Record Properties（约定字段）

由 `LoggerService`/`LogtapeLoggerService` 注入（约定）：

- `context`: 当前 Context 名称
- `pluginId` (可选): 插件 id（用于 filter）
- `name` (可选): UI 展示名（如 `plugin-a(pluginA)`；在 `hmr` runtime / `LoggerServiceConfig.preset="hmr"` 时默认注入）

`caller`（调用点）是可选字段：

- 默认：`LoggerService` 不再自动注入 `caller`（避免让 filters/sinks 读 properties 时意外触发堆栈捕获开销）。
- 控制台输出：pretty formatter 在 `includeCaller` 开启且 `caller` 缺失时，会按需 `captureCaller()`。
- 兼容：对非 pluxel logger（或调用方手动构造的 logger）同样适用。

你也可以显式传入 `{ caller: "..." }` 来覆盖显示（例如跨线程/跨进程场景）。

- 默认：开发/测试开启，生产环境关闭（可用 `PLUXEL_LOG_CALLER=0/1` 或 `PLUXEL_LOGGER_CALLER=0/1` 覆盖）
- 输出格式：`⤷ relative/path.ts:line:col`（优先相对 `process.cwd()`）

## 推荐用法（最佳实践）

普通日志：优先使用 tagged template（LogTape 推荐用例，避免手动拼接）。

```ts
ctx.logger.info`HMR started on ${port}`
```

需要结构化数据：用 method call 的 properties 参数（或 `with()` 绑定后再输出 message）。

```ts
ctx.logger.info('module loaded', { pluginId, file })
ctx.logger.with({ pluginId, file }).info`module loaded`
```

多条日志共享结构化数据：用 `with()`。

```ts
const log = ctx.logger.with({ pluginId, file })
log.info`module loaded`
log.warn`module updated`
```

错误日志：把 `error` 放进结构化属性（便于 pretty/youch/filters 识别）。

```ts
ctx.logger.error('execute failed', { error })
```

昂贵计算：用 LogTape 的 lazy callback，让成本只在该 level 启用时发生。

```ts
ctx.logger.debug((l) => l`cache keys:\n${keys.join('\n')}`)
```

动态/惰性属性：用 LogTape `lazy()`，让属性只在该 level 启用时求值（也避免冻结动态上下文）。

```ts
import { lazy } from '@logtape/logtape'

ctx.logger.with({ user: lazy(() => currentUserId()) }).info`request start`
```

## Debug channel（推荐）

调试日志统一走一个稳定的 channel：category 固定为 `["pluxel","debug"]`，topic 通过属性携带。

```ts
ctx.logger.getDebugChannel('pluxel:hmr:batch').debug('batch targets', { targets })
```

如何开启：在 LogTape 配置里指定 `debug: [...]`（支持 `: *` 前缀），pretty 输出会标注 `{dbg:...}`。

## Per-plugin levels（可选）

插件日志按 `record.properties.pluginId` 匹配，可在宿主侧配置不同最低等级：

```ts
await configure(
	createPluxelLogtapeConfig({
		preset: 'hmr',
		pluginLevels: {
			'*': 'info', // 默认
			'plugin-a': 'debug',
			'plugin-b': null, // 禁用
		},
	}),
)
```

如需动态调整，可传函数（自行读取你的 map/配置源）。

另外，`@pluxel/runtime/logger` 提供了一个可变的 `hmrPluginLevels`（`createPluxelPluginLevelState()`）
方便在运行时直接调级（无需重新 configure）。

## Sinks / Formatters

- `createPluxelPrettyConsoleSink()`：单入口「pretty console」，默认 `@logtape/pretty` + **默认启用 Youch（inline）**，且只对 `pluxelCategories.hmr/plugins` 的 error+ 做增强，避免 async 插入导致“错位 log”。
- `createPluxelPrettyFormatter()`：仅 formatter（不含 Youch；Youch 是 async，只能在 sink 层做）。
- `createPluxelYouchSink()`：独立 Youch sink（可组合）。
- Node-only 的 file sinks：放在 `@pluxel/runtime/logger`（或直接使用 `@logtape/file`）。

## Timestamp（时区）

`@logtape/pretty`/`@logtape/logtape` 默认时间戳格式基于 `Date#toISOString()`（UTC），本项目默认做了更符合使用场景的区分：

- console pretty：默认 **本地时区**（与计算机时间一致），可用 `PLUXEL_LOG_TZ=utc|local`（或 `PLUXEL_LOG_TIMEZONE=...`）覆盖
- file sink：默认 **UTC（+00:00）**，便于多机对齐/集中采集，可用 `PLUXEL_LOG_FILE_TZ=utc|local`（或 `PLUXEL_LOG_FILE_TIMEZONE=...`）覆盖

## 配置示例（宿主侧）

```ts
import { configure } from '@logtape/logtape'
import { createPluxelLogtapeConfig } from '@pluxel/core/logger'

await configure(
	createPluxelLogtapeConfig({
		preset: 'hmr', // or "core"
	}),
)
```

如果你在用 `@pluxel/runtime` 且希望直接传 `file: "./logs/app.log"`（daily rotation by prefix path），推荐用 runtime helper：

```ts
import { ensurePluxelLogging } from '@pluxel/runtime/logger'

await ensurePluxelLogging({
	preset: 'hmr',
	file: './logs/app.log',
	// 关闭 Youch（仅保留 pretty 的 error.stack 输出）
	// console: { youch: false },
	// 自定义 prefix（hmr 默认是 "name"；core 默认是 "context"）
	// console: { pretty: { prefix: "context" } },
	// 开启 debug（支持前缀；debug 会走统一 channel `pluxel:debug` 并标注 `{dbg:...}`）：
	// debug: ["pluxel:hmr:*", "pluxel:ext:compile"],
})
```
