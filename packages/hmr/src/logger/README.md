# @pluxel/hmr/logger

`@pluxel/hmr` 的 logger 模块提供 **UI 日志流**（SSE）与 HMR 场景的约定字段。

## UI Log Store

- `createLogStoreSink()`：把 LogTape `LogRecord` 写入内存 `logStore`，用于 UI 日志。
- `toUiLogRecord()`：把 `LogRecord` 转成 UI 友好的结构（安全序列化 properties，并默认剔除 `caller`）。

推荐做法：宿主在启动入口显式配置 LogTape。

- 如果你想“无痛开箱”，用 `ensurePluxelLogging()`：它会在未配置时执行一次 `configure(...)`（包含 UI log store）。
- 如果你希望完全自定义日志（或绑定更多 category 到 UI sink），就自行调用 LogTape 的 `configure(...)`，并不要调用 `ensurePluxelLogging()`。

## Transport

- `/api/logs/latest` 默认返回 `application/json`（`{ records, lastId, bootId }`），也支持 `?format=jsonl` 输出 NDJSON。
- `/api/logs/stream` 提供独立 SSE 日志流（event: `ready` / `log`），并使用 SSE `id:` 支持断线续传（配合 `Last-Event-ID`）。

### Filters

`/api/logs/latest` 与 `/api/logs/stream` 共享同一套过滤参数（全部为精确匹配）：

- `name`：兼容旧筛选；匹配 `pluginId` / `context` / `name`
- `pluginId`
- `context`
- `displayName`：只匹配 `record.name`
- `category`：形如 `pluxel.hmr` / `pluxel.plugins`，支持 `prefix.*`

## Debug topics

HMR 细粒度 debug 采用 topic（例如 `pluxel:hmr:batch`），并通过一个统一的 debug channel 输出：
- category 固定为 `["pluxel","debug"]`
- topic 写在 `record.properties.debugTopic`，pretty 输出会标注 `{dbg:...}`

开启方式（二选一）：
- 宿主手动 `configure(createPluxelLogtapeConfig({ debug: [...] }))`
- 或使用 HMR 默认自动配置时，在 root Context 配置 `debug: [...]`（例如 `debug: ["pluxel:hmr:*"]`）

类型提示：`@pluxel/hmr` 会通过 module augmentation 为常见 topic 提供 IntelliSense；宿主也可以自行扩展：

```ts
declare module "@pluxel/core" {
  namespace Context {
    interface DebugTopics {
      "pluxel:hmr:*": true
      "pluxel:ext:compile": true
    }
  }
}
```
