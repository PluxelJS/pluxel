# @pluxel/hmr/logger — Runtime Logs (V1)

`@pluxel/hmr/logger` 提供一套 **运行时日志（Runtime Logs）** 的端到端方案：

- 应用侧继续用 LogTape 打结构化日志（`record.message` + `record.properties`）。
- 通过 LogTape Sink 规范化为统一的 `RuntimeLogLine`（append-only），写入内存窗口。
- 通过 HTTP + SSE 把同一套数据暴露给 UI/工具（不依赖 `@melloware/react-logviewer`）。

本模块**允许破坏兼容**：以 V1 协议/端点为准。

---

## 1) 概念与不变式

- `streamId`：一条逻辑日志流（默认 `"default"`）。
  - 额外的 `plugin:<pluginId>` / `context:<context>` 以 **虚拟视图** 形式存在：它们仍由 `default` store 提供数据，只是在服务端自动附加筛选条件（不会创建/维护成百上千个 per-plugin store）。
- `bootId`：进程实例标识（帮助客户端发现“进程重启但 epoch 未必同步”的情况）。
- `epoch`：重置版本号；发生 reset 时递增（reset 会使所有 cursor 失效）。
- `seq`：同一 epoch 内单调递增（`uint64 string`），用于 cursor/SSE `Last-Event-ID`。

关键不变式：

- **append-only**：同一 epoch 内只追加，不回写。
- **cursor 与过滤解耦**：`range.nextSeq` 表示“继续扫描的 cursor”，不等于“返回行数”。

类型定义见：`packages/hmr/src/logger/protocol.ts`。

---

## 2) 数据模型：`RuntimeLogLine`

面向 UI 的核心字段：

- `ts`/`level`/`category`：渲染与筛选主键。
- `msg`：主列表的快速单行文本（避免服务端对大对象做深 stringify）。
- `message`/`props`/`error`/`raw`：详情面板用（可通过 sink 选项裁剪/关闭）。
- `name`/`pluginId`/`context`：HMR 友好来源信息（用于筛选与分流）。

---

## 3) 接入方式

### 3.1 一键开箱：`ensurePluxelLogging()`

宿主入口调用一次即可（若尚未配置 LogTape，会执行 `configure(...)` 并默认启用 runtime logs sink）：

```ts
import { ensurePluxelLogging } from "@pluxel/hmr/logger";

await ensurePluxelLogging({
  ui: {
    minLevel: "trace",
    windowLines: 200_000,
  },
});
```

注意：`ui` 现在接受完整 `RuntimeLogSinkOptions`（见 `packages/hmr/src/logger/ensure.ts`）。

### 3.2 自定义：`createRuntimeLogSink()`

如果宿主想完全自定义 LogTape（多 sink/自定义 filter 等），可以直接使用：

- `createRuntimeLogSink(options)`（`packages/hmr/src/logger/sink.ts`）
- 或在 `createPluxelLogtapeConfig({ ui: { sink } })` 中挂载

---

## 4) Sink 选项（`RuntimeLogSinkOptions`）

高频常用：

- `bufferSize` / `flushIntervalMs`：非阻塞批处理。
- `windowLines`：default stream 的窗口大小（默认 200k 行）。
- `hiddenKeys` / `redactKeys`：在 sink 层做清洗（避免敏感字段进入 store）。
- `includeCaller` / `includeRaw`：详情字段开关。

安全裁剪（可选）：

- `caps.maxMsgChars` / `caps.maxMessageParts` / `caps.maxMessagePartChars` / `caps.maxPropsKeys`。

---

## 5) Store 语义（`RuntimeLogStore`）

实现：`packages/hmr/src/logger/store.ts`（chunked ring：chunk=1024，窗口上限 2M 行）。

### 5.1 `range()` cursor 语义（非常重要）

`range({ epoch, fromSeq, limit, filter })` 返回：

- `lines`: **匹配 filter 的行**
- `nextSeq`: **继续扫描的 cursor**（等于 `fromSeq + scannedTotal`）

所以：

- 即使 filter 很严格导致 `lines.length` 很小，`nextSeq` 仍会向前推进；
- 客户端若要“找齐所有匹配”，就持续用 `nextSeq` 继续 range，直到 `nextSeq === meta.nextSeq`。

### 5.2 过滤加速

store 内部维护 chunk 级 meta（`pluginId/context/name/category` 计数），允许在 `range()` 扫描时整块跳过；
具体匹配使用“编译后的 filter”避免每行 `category.join('.')` 的热点开销。

---

## 6) HTTP API（V1）

挂载路径：`/__pluxel/hmr/logs`

### 6.1 Streams

- `GET /__pluxel/hmr/logs/v1/streams`：列出当前进程已存在的 streams（调试用）。
- `GET /__pluxel/hmr/logs/v1/streams/:streamId/meta`：返回 `LogStreamMeta`。
- `GET /__pluxel/hmr/logs/v1/streams/:streamId/stats`：返回 `{ meta, subscribers }`（确认是否有人在消费）。

注意：

- `"default"` 永远存在（进程启动后初始化）。
- `plugin:<pluginId>` / `context:<context>` 始终可用（虚拟视图，不需要 sink 预先创建 store）。
- 其它自定义 streamId 需要确实存在（否则返回 404）。

### 6.2 Range

`GET /__pluxel/hmr/logs/v1/streams/:streamId/range`

参数：

- `epoch`：可省略（省略则使用当前 epoch）
- `from`：起始 cursor（默认 `headSeq`）
- `limit`：默认 2000，最大 20000
- filters（精确匹配）：
  - `name`：兼容单键筛选；匹配 `pluginId` / `context` / `name`
  - `pluginId`
  - `context`
  - `displayName`：只匹配 `name`
  - `category`：`a.b.c` 或 `a.b.*`

返回：

- `ok: true`：`{ lines, nextSeq }`
- `ok: false`：`epoch_mismatch`（409） / `from_too_old`（410） / `invalid`（416）

### 6.3 Follow（SSE）

`GET /__pluxel/hmr/logs/v1/streams/:streamId/follow`

行为：

- **永远先发送一条 `reset`**（客户端可将其视为“ready + meta”）。
- 随后服务端会基于 `from`（或 `Last-Event-ID + 1`）做一次**有界 catch-up**，再进入实时追加。
- 默认不传 `from` 时按 `tail -f`：从 `meta.nextSeq` 开始（不含历史）。

事件：

- `reset`：包含 meta（客户端应清空缓存并重建 cursor）
- `append`：追加 batch（SSE `id:` 为该 batch 的 last seq）
- `gap`：服务端背压丢弃（客户端需用 `/range` 补洞）

连接细节：

- keepalive：服务端会周期性写入 SSE comment `: ping`（客户端无需处理）。
- `X-Accel-Buffering: no`：避免某些反代缓冲导致 SSE 延迟。

---

## 7) Follow 参数调优（可选）

`/follow` 的背压/追赶行为可以通过环境变量调整（不设置则使用默认值）：

- `PLUXEL_LOGS_FOLLOW_MAX_PENDING_LINES`（默认 5000）
- `PLUXEL_LOGS_FOLLOW_MAX_PENDING_BYTES`（默认 2000000）
- `PLUXEL_LOGS_FOLLOW_CATCHUP_LIMIT`（默认 5000）
- `PLUXEL_LOGS_FOLLOW_MAX_BUFFERED_APPEND_LINES`（默认 20000）
- `PLUXEL_LOGS_FOLLOW_PING_INTERVAL_MS`（默认 15000）

---

## 8) 前端参考实现

当前仓库内的参考实现（固定行高 + 虚拟列表 + follow 行为 + gap 补洞 + ANSI SGR 渲染）：

- `packages/components/src/app/log_viewer/LiveLog.tsx`

---

## 9) 迁移提示（Breaking）

- 旧的 logs 端点/协议已不再兼容；以 `/__pluxel/hmr/logs/v1/...` 为准。
- 工具（MCP）返回结构也已切到 `{ meta, lines }`（见 `packages/hmr/src/api/mcp/index.ts`）。

---

## 10) Debug topics（HMR）

HMR 的细粒度 debug 使用 topic（例如 `pluxel:hmr:*`），并通过统一的 debug channel 输出：

- `category` 固定为 `["pluxel","debug"]`
- topic 写在 `record.properties.debugTopic`

开启方式（二选一）：

- 宿主手动 `configure(createPluxelLogtapeConfig({ debug: [...] }))`
- 或 `ensurePluxelLogging({ debug: [...] })`

---

## 11) Per-plugin log levels（HMR）

HMR 场景下推荐把 “`pluginId -> level`” 当作运行时规则由面板管理（而不是在入口硬编码一堆映射）。

实现上，`ensurePluxelLogging()` 会把 `hmrPluginLevels.lookup` 注入到 LogTape filter（每条记录做一次 lookup，不创建 per-plugin logger config）。
