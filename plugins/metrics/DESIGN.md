# Metrics 插件设计

## 边界与作者模型

Metrics 只提供 operation RED：完成调用数、throw/reject 错误数和完成耗时。公开入口只有 concrete
`MetricsPlugin.measure(operation, run)`；不提供 decorator、抽象 provider、optional no-op facade、raw instrument、arbitrary
attributes 或 Pluxel config。

这是一个 required、caller-aware capability。constructor injection 复用正常 DI graph 和 caller-bound Context；plugin ID 从
`ctx.caller.pluginInfo.id` 取得，作者只能选择 operation。OTLP 是部署边界，不是作者 API。OpenTelemetry provider、reader、
exporter 和 instrument 均留在 package-private 动态模块，不进入 public declaration。

错误分类有意只采用语言语义：同步 throw 和 thenable rejection 为 `error`，其他 completion 为 `ok`。Domain result 需要由所属
领域定义自己的数据字典，不把 `measure()` 扩成 classifier 或通用 metrics SDK。

## 固定数据 contract

provider 创建一个 local `MeterProvider`、一个 Meter、一个 periodic reader、一个 OTLP protobuf exporter、两个 operation
instrument 和一个 capacity-drop counter，不安装 global OTel provider 或 global diagnostics。

| Instrument                                       | Aggregation              | Cardinality attributes              |
| ------------------------------------------------ | ------------------------ | ----------------------------------- |
| `pluxel.plugin.operation.calls`, `{call}`        | delta sum                | plugin ID + operation + `ok\|error` |
| `pluxel.plugin.operation.duration`, `s`          | delta explicit histogram | plugin ID + operation               |
| `pluxel.metrics.operation_limit.drops`, `{drop}` | delta sum                | `total\|per_plugin`                 |

Histogram boundaries 固定为 5ms、10ms、25ms、50ms、100ms、250ms、500ms、1s、2.5s、5s、10s、30s、60s。
Resource `service.name` 依次取 `OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES` 中的 `service.name`、root Context name。

固定 registry cap 为 total 1,024、per-plugin 128；operation name 上限 128 UTF-8 bytes。SDK reader 和 view 另设
instrument-specific cardinality limit，作为 registry 验证后的第二道边界。达到 cap 不保存被拒绝的 operation identity，不扫描或
淘汰 active slot。

## 热路径与业务语义

首次调用为 caller 登记 effects cleanup，并缓存 `(plugin ID, operation)` slot 与三个冻结 attribute object。稳定热路径只包含
owner/operation Map lookup、两次 monotonic clock read、counter add 和 histogram record；不使用 AsyncLocalStorage、stack
capture、argument serialization、per-call log 或网络等待。

同步 callback 不创建 Promise。PromiseLike 使用 `Promise.resolve()` 规范化并观察 settlement。callback 返回值、throw value 和
rejection reason 均不被 telemetry 替换。永久 pending 不产生 completion；iterator、generator 和 stream 只测量对象创建。

recording 或 exporter failure 不能改变业务结果。只有无效作者输入在 callback 前抛出 `TypeError`，以及无效启动环境使
provider 按正常 Plugin lifecycle 失败。

micro-benchmark 固定比较 direct callback、cached sync/async measurement 和跨 128 个 cached operation 的 lookup，防止热路径
无意加入 serialization、allocation-heavy attributes 或线性扫描。

## Ownership 与 delta lifecycle

每个 caller Context generation 拥有其 operation registrations，并在 caller effects 中登记 cleanup：

1. caller stop、rollback 或 replacement 立即令 owner 失效；之后 settle 的异步调用保留业务结果但不记录；
2. 最后一个 owner 释放后 slot 进入 retiring，仍计入 total/per-plugin cap；
3. 下一次成功 local collection 轮转 delta aggregation 后回收 retiring slot；
4. collection 前出现相同 plugin ID + operation 的新 generation 时复用 slot 并取消 retirement。

collection hook 位于 reader，而不是 exporter，因此没有 metric data 或 export 被跳过时也能回收 retiring registrations。回收只依赖
成功 local collection，不依赖远端 export 成功；这允许 export failure 丢弃一个 interval，同时避免 HMR 在 collection interval
内绕过固定容量。

provider stop/replacement 先停止 measurement 并清空 owner registry，再由 effects-owned shutdown 停止 timer、执行 SDK final
collection/export 并关闭 exporter。SDK timeout 约束 transport；实现不使用只停止等待、但没有取消底层工作的外层
`Promise.race`。Exporter 已取得、但 provider 或 effect 尚未完成登记时若初始化失败，初始化路径直接关闭已取得的 OTel
资源并保留原始启动错误。

## OTLP 与失败边界

只支持 OTLP/HTTP protobuf 和 delta temporality。Signal-specific endpoint、headers 和 protocol 优先于 generic fallback；generic
endpoint 自动追加 `/v1/metrics`。环境解析对 URL scheme/userinfo、percent encoding、header syntax、重复 key、entry count、UTF-8
bytes、interval 和 timeout 设硬上限。

Exporter concurrency 固定为 1，不提供应用内 retry queue、durable delivery 或 fan-out。Collector/backend 不可达时当前 interval
best-effort 丢失；首次失败和持续失败的每分钟窗口各限频记录诊断，恢复记录一次状态变化。日志只包含 bounded error type，不包含
header、endpoint、payload、response body、argument、return value 或业务错误内容。

## 验证

- Runtime 单元测试覆盖 sync/async success/error、thenable、无效 name、容量、retirement、late settlement 和 recording failure；
- 真实 Pluxel host 测试覆盖 constructor graph、caller identity、consumer cleanup 和 provider restart；
- Node integration 使用真实 OTel SDK 验证 resource、instrument、unit、attributes、explicit buckets、delta、empty collection、
  exporter failure 和实际 OTLP protobuf HTTP request；
- typecheck/build 检查 public declaration 不泄漏 OTel 或 package-private contract；benchmark 守护 steady-state hot path。
