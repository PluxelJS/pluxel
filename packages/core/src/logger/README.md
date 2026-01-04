# @pluxel/core/logger (LogTape)

`@pluxel/core` 是 **logger 封装与约定**，不是 logger runtime：不会在库内部调用 `configure()`。
宿主（app / CLI / tests/start.ts）必须显式配置 LogTape。

## Categories

- `pluxelCategories.core` → `["pluxel","core"]`
- `pluxelCategories.hmr` → `["pluxel","hmr"]`
- `pluxelCategories.plugins` → `["pluxel","plugins"]`

插件分型不扩 category：统一使用 `["pluxel","plugins"]`，插件身份通过属性携带，便于 filter。

## Record Properties（约定字段）

由 `LoggerService`/`LogtapeLoggerService` 注入：

- `context`: 当前 Context 名称
- `pluginId` (可选): 插件 id（用于 filter）
- `name` (hmr 可选): UI 展示名（如 `plugin-a(pluginA)`）
- `caller` (可选): 调用点（默认开启；可用 `PLUXEL_LOG_CALLER=0` 或 `PLUXEL_LOGGER_CALLER=0` 关闭）
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

多条日志共享结构化数据：用 `with()`（注意：`caller` 会在 `.with()` 调用点捕获）。

```ts
const log = ctx.logger.with({ pluginId, file })
log.info`module loaded`
log.warn`module updated`
```

错误日志：把 `error` 放进结构化属性（便于 pretty/youch/filters 识别）。

```ts
ctx.logger.error("execute failed: {error}", { error })
```

昂贵计算：用 LogTape 的 lazy callback，让成本只在该 level 启用时发生。

```ts
ctx.logger.debug((l) => l`cache keys:\n${keys.join('\n')}`)
```

## Sinks / Formatters

- `createPluxelPrettyConsoleSink()`：单入口「pretty console」，默认 `@logtape/pretty`，可选叠加 Youch ANSI 错误增强。
- `createPluxelPrettyFormatter()`：仅 formatter（不含 Youch；Youch 是 async，只能在 sink 层做）。
- `createPluxelYouchSink()`：独立 Youch sink（可组合）。
- `getFileSink/getRotatingFileSink/getStreamFileSink`：官方 file sinks 透传再导出。

## 配置示例（宿主侧）

```ts
import { configure } from "@logtape/logtape";
import {
  createPluxelPrettyConsoleSink,
  getRotatingFileSink,
} from "@pluxel/core/logger";

await configure({
  sinks: {
    console: createPluxelPrettyConsoleSink({
      pretty: { timestamp: "time", prefix: "context", includeCaller: true },
      youch: { minLevel: "error" },
    }),
    file: getRotatingFileSink("./logs/app.log"),
  },
  loggers: [
    { category: ["pluxel"], sinks: ["console", "file"], lowestLevel: "info" },
    { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "error" },
  ],
});
```
