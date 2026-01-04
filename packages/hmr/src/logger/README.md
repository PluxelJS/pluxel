# @pluxel/hmr/logger

`@pluxel/hmr` 的 logger 模块提供 **UI 日志流**（SSE）与 HMR 场景的约定字段。

## UI Log Store

- `createLogStoreSink()`：把 LogTape `LogRecord` 写入内存 `logStore`，用于 UI 日志。
- `toUiLogRecord()`：把 `LogRecord` 转成 UI 友好的结构（安全序列化 properties，并默认剔除 `caller`）。

宿主侧通过 LogTape `configure()` 把 `["pluxel","hmr"]` / `["pluxel","plugins"]` 等 category 绑定到该 sink 即可。

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

## Debug namespaces

HMR 细粒度 debug 采用 category（如 `pluxel:hmr:batch` → `["pluxel","hmr","batch"]`）。
开启方式：在宿主的 LogTape 配置里把对应 category 的 `lowestLevel` 设为 `"debug"`。
