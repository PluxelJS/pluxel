# @pluxel/core/logger (LogTape)

`@pluxel/core` 是 **logger 封装与约定**，不是 logger runtime：不会在库内部调用 `configure()`。
宿主（app / CLI / tests/start.ts）必须显式配置 LogTape。

## Categories

- `pluxelCategories.core` → `["pluxel","core"]`
- `pluxelCategories.hmr` → `["pluxel","hmr"]`
- `pluxelCategories.plugins` → `["pluxel","plugins"]`

插件分型不扩 category：统一使用 `["pluxel","plugins"]`，插件身份通过属性携带，便于 filter。

## Record Properties（约定字段）

由 `LoggerService`/`LogtapeLoggerService` 注入（约定）：

- `context`: 当前 Context 名称
- `pluginId` (可选): 插件 id（用于 filter）
- `name` (hmr 可选): UI 展示名（如 `plugin-a(pluginA)`）

`caller`（调用点）是可选字段：

- 默认：当开启 caller 时，`LoggerService` / `LogtapeLoggerService` 会在 `ctx.logger.info/warn/...` 这类直接调用里注入 `caller`（更利于 file/json sink 保留调用点）
- 兼容：对 `ctx.logger.with(...)` 返回的 LogTape logger、或非 pluxel logger，pretty formatter 会在渲染时发现 `caller` 缺失并按需捕获（不破坏外部 logger）

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
ctx.logger.info("module loaded", { pluginId, file })
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
ctx.logger.error("execute failed", { error })
```

昂贵计算：用 LogTape 的 lazy callback，让成本只在该 level 启用时发生。

```ts
ctx.logger.debug((l) => l`cache keys:\n${keys.join('\n')}`)
```

## Debug channel（推荐）

调试日志统一走一个稳定的 channel：category 固定为 `["pluxel","debug"]`，topic 通过属性携带。

```ts
ctx.logger.getDebugChannel("pluxel:hmr:batch").debug("batch targets", { targets })
```

如何开启：在 LogTape 配置里指定 `debug: [...]`（支持 `: *` 前缀），pretty 输出会标注 `{dbg:...}`。

## Sinks / Formatters

- `createPluxelPrettyConsoleSink()`：单入口「pretty console」，默认 `@logtape/pretty` + **默认启用 Youch（inline）**，且只对 `pluxelCategories.hmr/plugins` 的 error+ 做增强，避免 async 插入导致“错位 log”。
- `createPluxelPrettyFormatter()`：仅 formatter（不含 Youch；Youch 是 async，只能在 sink 层做）。
- `createPluxelYouchSink()`：独立 Youch sink（可组合）。
- `getFileSink/getRotatingFileSink/getStreamFileSink`：官方 file sinks 透传再导出。

## 配置示例（宿主侧）

```ts
import { configure } from "@logtape/logtape";
import {
  createPluxelLogtapeConfig,
} from "@pluxel/core/logger";

await configure(
  createPluxelLogtapeConfig({
    preset: "hmr", // or "core"
    file: "./logs/app.log",
  }),
);
```

覆盖/追加（常见例子）：

```ts
await configure(
  createPluxelLogtapeConfig({
    preset: "hmr",
    file: "./logs/app.log",
    // 关闭 Youch（仅保留 pretty 的 error.stack 输出）
    // console: { youch: false },
    // 自定义 prefix（hmr 默认是 "name"；core 默认是 "context"）
    // console: { pretty: { prefix: "context" } },
    // 开启 debug（支持前缀；debug 会走统一 channel `pluxel:debug` 并标注 `{dbg:...}`）：
    // debug: ["pluxel:hmr:*", "pluxel:ext:compile"],
  }),
);
```
