# OpenTelemetry 插件设计

## 决策

`@pluxel/otel` 是 OTel SDK 的 Pluxel 生命周期装配层。公开作者 contract 只有 concrete `OtelPlugin` 的三个 caller-scoped
getter：

| Contract | 原生类型                           | instrumentation scope                 |
| -------- | ---------------------------------- | ------------------------------------- |
| `meter`  | `@opentelemetry/api` `Meter`       | caller Plugin node address projection |
| `tracer` | `@opentelemetry/api` `Tracer`      | caller Plugin node address projection |
| `logger` | `@opentelemetry/api-logs` `Logger` | caller Plugin node address projection |

Plugin 不拥有 instrument/span/log 数据模型，不包装热路径，不猜测业务结果，也不提供 arbitrary provider mutation。events 使用原生
OTel Logger 的 `eventName`，而不是增加第四套 event API。

配置直接描述输出 ownership：

```ts
type OtelPluginConfig = {
	otlp: Array<'metrics' | 'traces' | 'logs'>
	prometheus: false | { path: string }
}
```

默认 `otlp` 启用三个 signal，Prometheus 关闭。`otlp` 可为空，但此时必须开启 Prometheus。Prometheus 只属于 metrics；它不是一个
OTLP signal。

## 运行时结构

每个 active `OtelPlugin` generation 共享一个 resource，并分别拥有 local provider：

```text
caller.meter  -> MeterProvider  -> PeriodicMetricReader -> signal OTLP exporter
                              `-> PrometheusPullReader -> Pluxel plugin HTTP route

caller.tracer -> BasicTracerProvider -> BatchSpanProcessor -> signal OTLP exporter

caller.logger -> LoggerProvider -> BatchLogRecordProcessor -> signal OTLP exporter
```

每个 OTLP exporter 按 signal 独立解析 endpoint/protocol/headers/timeout/compression，并动态加载 `grpc`、`http/protobuf` 或
`http/json` 官方 exporter 包。关闭的 signal 不解析环境变量、不构造 provider/processor/exporter。metrics 的两个 reader 独立
collection，Prometheus scrape 不等待 push interval。

不注册 global OTel provider。一个进程可运行多个 Host、测试 Host 和 replacement generation；global provider 的 write-once contract
会让其中一个 generation 意外取得永久 authority。constructor required dependency 使 enable、verification、stop、rollback 和
replacement 继续服从普通 Plugin graph。

## Context 与传播

native `Tracer.startActiveSpan()` 和 log correlation 依赖 process context manager。第一次启用 traces 或 logs 时，本包尝试安装一个
process-stable `AsyncLocalStorageContextManager`，以及组合的 W3C tracecontext/baggage propagator：

- application 已安装的 global coordinator 始终优先，本包不覆盖；
- 只在全部已选择 provider 构造成功后安装，普通配置或 exporter 初始化失败不会提前留下 global state；
- coordinator 不持有任何 provider/exporter；没有 active scope 时是 inert；
- owner generation drain 后不 unregister，因为 global unregister 会破坏同进程其他 Host 或 application instrumentation；
- provider 始终是 generation-local，context 中只短暂携带标准 OTel span/context value。

这是一项稳定、不可逆但无业务 authority 的 process coordination；它与注册 global provider 有本质区别。

## 生命周期与失败语义

provider、reader、processor、queue、timer、exporter 与 pending scrape 都由一个 Plugin generation 拥有。初始化中途失败会并行
best-effort 关闭全部已取得资源并保留原始错误；成功后只注册一次 owner effect。公开 runtime 在 stop 时先撤销，随后幂等 shutdown
flush 三个 provider。一个 provider shutdown 失败不会跳过其他 provider。

metrics periodic reader、BSP 和 BLRP 都有有界 batch/queue/delay/export timeout。BLRP 上游当前不读取 `OTEL_BLRP_*`，因此本包显式
解析后传入 SDK；BSP 也显式传入以统一限制与测试隔离。官方 exporter 自己实现 OTLP transient retry。

export 诊断包装器保留原生 exporter 语义，只上报 `{ signal, ok }` 或 bounded `errorType`。首次失败、每分钟持续失败窗口和恢复按
signal 分开记录；不会记录 endpoint、headers、payload、response 或任意业务 attributes。Prometheus collection error 返回 503。

## 环境与安全

signal-specific OTLP 设置覆盖 generic 设置。HTTP generic endpoint 追加标准 `/v1/{signal}`，specific endpoint 视为完整 URL；gRPC
endpoint 永不追加 path。headers 先合并 generic，再由 signal-specific 覆盖。URL userinfo 被拒绝，认证必须走 headers/mTLS。

环境输入在启动时读取，对 percent encoding、header field、duplicate、entry count、UTF-8 bytes、URL、queue、batch、interval 与
timeout 做硬限制。TLS certificate/client key/client certificate 及 gRPC insecure 交由官方 Node exporter 按标准环境变量加载。

resource 是 `defaultResource()` 与显式环境 attributes 的 merge；`service.name` 依次取 `OTEL_SERVICE_NAME`、
`OTEL_RESOURCE_ATTRIBUTES`、root Context name，并共享给所有启用 signal。

## 非目标与上游阻塞

- 不提供 `measure()`、decorator、RED wrapper、固定 instruments 或 attribute registry；
- 不自动 instrument runtime、HTTP、database 或业务 Plugin；
- 不把 `ctx.logger` 悄悄桥接到 logs signal；RuntimeLogging 仍由 launcher 独占配置；
- 不在应用内实现 durable queue、fan-out、backend routing、dashboard 或 alerting；
- 不支持 OTLP Profiles：协议仍是 `v1development`，OTel JS 2.10/0.221 没有 profiles API、SDK/exporter package。

## 验证

- Pluxel Host 测试覆盖 required graph、caller cache、disabled signal、Prometheus route 与 cascade replacement；
- capturing exporters 覆盖三个 signal 的 resource/scope、原生数据、active async context、log trace correlation、幂等 shutdown 与
  partial-init cleanup；
- 本地真实 receiver 覆盖三 signal 的 HTTP protobuf、HTTP JSON 与 gRPC wire request；
- Victoria-compatible integration 覆盖 VictoriaMetrics/VictoriaLogs 的完整 signal-specific endpoint；
- build/typecheck 验证公开 peer types 和动态 exporter package boundaries。
