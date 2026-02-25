# Runtime Logs V1 — Design Notes（与当前实现同步）

这份文档记录 **已经落地的 V1 设计边界** 与关键取舍；它不是“理想蓝图”，而是“为什么现在这样实现”。

实现位置：

- 协议：`packages/hmr/src/logger/protocol.ts`
- Sink：`packages/hmr/src/logger/sink.ts`
- Store：`packages/hmr/src/logger/store.ts`
- HTTP/SSE：`packages/hmr/src/api/hono/logs.ts`
- 前端参考：`packages/components/src/app/log_viewer/LiveLog.tsx`

---

## 1) 场景假设

- **单进程内存窗口**：日志暂不持久化（V1 仅内存 retention）。
- **客户端通常 1 个（最多 2~3）**：优先保证“单订阅可靠 + 交互好用”。
- **插件基数可到几百**：系统不应因为“按插件分流”而产生大量 store/索引/列表噪音。

---

## 2) 目标与非目标

目标：

- 吞吐：单进程可支撑 **几百行/秒** 级别追加，UI 固定行高虚拟列表稳定渲染。
- 可靠：断线重连、catch-up、并发 append 等情况下 **不乱序、不漏**；必要时以 `gap + range` 恢复。
- 安全：敏感字段在 sink 层清洗；极端 payload 通过 `caps.*` 兜底，避免把大对象直接灌进 UI。

非目标（V1）：

- 全文检索/复杂查询语言/正则查询。
- 持久化到磁盘/外部系统。
- 与其它 SSE 通道强行合并（目前 logs 独立 `/__pluxel/hmr/logs/v1/.../follow`）。

---

## 3) 不变式（协议层）

- **append-only**：同一 `epoch` 内只追加。
- **`seq` 单调递增**：使用 `uint64 string`（SSE 友好，规避 JS safe-int）。
- **`epoch` reset**：reset 使 cursor 失效；客户端必须清空缓存并重新定位。
- **cursor 与过滤解耦**：`range.nextSeq` 表示“继续扫描的 cursor”，与返回行数无关。

---

## 4) Streams：物理 store 与虚拟视图

### 4.1 物理 store（materialized）

物理 store 由 sink 写入创建（默认 `streamId="default"`；也允许宿主自定义 `streamId`）。

### 4.2 虚拟视图（virtual）

为适配“插件基数几百”的现实场景，`plugin:<pluginId>` / `context:<context>` 在 V1 以 **虚拟视图** 形式提供：

- 这些 stream id 不会创建 per-plugin/per-context store；
- 服务端将其映射到 `default` store，并自动附加筛选条件（`pluginId` 或 `context`）。

这样做的收益：

- 避免 store 数量爆炸与 LRU thrash；
- `/streams` 不会因为插件多而变成不可用的巨长列表；
- UI 仍可用“按插件查看”并保持性能（store 有 chunk 级 meta 可整块跳过）。

---

## 5) 过滤与性能

过滤字段（exact）：

- `name`：兼容单键筛选；匹配 `pluginId/context/name`
- `pluginId` / `context` / `displayName`
- `category`：支持 `a.b.c` 与 `a.b.*`

实现采用：

- `compileLogFilter()` + `matchesLogFilterCompiled()`：避免每行 `category.join('.')` 热点
- store 内维护 chunk 级 meta（`pluginId/context/name/category` 计数）：允许 range 扫描时整块跳过

---

## 6) Sink（LogTape → Runtime Logs）

核心策略：

- **非阻塞批处理**：`bufferSize` / `flushIntervalMs`
- **清洗与裁剪**：`hiddenKeys` / `redactKeys` + `caps.*`
- **只写入一个物理 stream**：默认写入 `default`（或宿主显式指定 `streamId`）

把清洗放在 sink 层的原因：

- store 与传输层都应视为“不可信落盘区”（即使目前仅内存），避免敏感字段后置清洗遗漏。

---

## 7) Store（内存窗口 + chunked ring）

数据结构：chunked ring（chunk=1024），按行数 retention（上限 2M 行）。

选择 chunked 的原因：

- 避免数组 shift/splice 的 O(n) 搬迁；
- 支撑 chunk 级 meta，提升“过滤命中稀疏”时的跳过效率。

`range()` 的 nextSeq 语义：

- `nextSeq = fromSeq + scannedTotal`（scannedTotal 统计扫描过的“全量行数”）
- 使 cursor 在“过滤命中很稀疏”时仍稳定前进，不会卡死在同一区间。

---

## 8) HTTP / SSE（V1）

端点：

- `GET /__pluxel/hmr/logs/v1/streams`
- `GET /__pluxel/hmr/logs/v1/streams/:id/meta`
- `GET /__pluxel/hmr/logs/v1/streams/:id/stats`
- `GET /__pluxel/hmr/logs/v1/streams/:id/range`
- `GET /__pluxel/hmr/logs/v1/streams/:id/follow`

follow 的实现要点：

- 连接建立后 **永远先发 reset**（作为“ready + meta”）。
- catch-up 期间缓冲并发 append，避免 cursor 被实时事件推进导致漏历史。
- pending lines + pending bytes 双阈值背压：超限则发送 `gap`，客户端用 `/range` 补洞。
- keepalive 用 SSE comment `: ping`，并设置 `X-Accel-Buffering: no` 避免反代缓冲。

---

## 9) 前端参考实现（非协议的一部分）

`packages/components/src/app/log_viewer/LiveLog.tsx` 的落地策略：

- TanStack Virtual 固定行高虚拟列表（不做自动换行，避免动态测量）。
- EventSource + `reset/append/gap` 状态机；gap 通过 `/range` 补洞。
- ANSI SGR 渲染（可开关），并把多行/Tab 显式化保证单行可读。
- 高频追加用 ring store + `useSyncExternalStore`：限制重渲染范围（列表更新不拖累整个面板）。

---

## 10) 深水区（不在 V1 交付范围）

如果未来要进一步优化（更高吞吐 / 更多订阅者 / 更复杂 UI）：

- SSE fanout hub（按 stream 预序列化 batch，一次编码多路广播）。
- logs follow 合并进统一 SSE 命名空间（连接复用、统一 auth/重连/指标）。
- byte-accurate retention（当前按行数；极端 payload 依赖 sink caps）。
- “facets/建议”接口：给 UI 提供最近窗口内的 pluginId/context/category 热点键（用于自动补全）。
- pinned keys / props 交互式筛选（仍应保持主列表行高固定，不做复杂树形渲染）。
