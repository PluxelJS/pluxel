# `@pluxel/otel`

Pluxel 官方 OpenTelemetry runtime。下游 Plugin 直接获得原生 OTel `Meter`、`Tracer` 和 `Logger`；本包只负责
provider、resource、OTLP push、Prometheus pull、上下文传播和生命周期，不定义第二套 telemetry 数据模型。

```sh
pnpm add @pluxel/otel @opentelemetry/api @opentelemetry/api-logs
```

## 下游作者 API

```ts
import type { Counter } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { OtelPlugin } from '@pluxel/otel'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'CatalogPlugin' })
class CatalogPlugin extends BasePlugin {
	private refreshed!: Counter

	constructor(private readonly otel: OtelPlugin) {
		super()
	}

	protected override init(): void {
		this.refreshed = this.otel.meter.createCounter('catalog.refreshes')
	}

	async refresh(): Promise<void> {
		await this.otel.tracer.startActiveSpan('catalog.refresh', async (span) => {
			try {
				this.refreshed.add(1, { result: 'ok' })
				this.otel.logger.emit({
					severityNumber: SeverityNumber.INFO,
					body: 'catalog refreshed',
					attributes: { result: 'ok' },
				})
			} finally {
				span.end()
			}
		})
	}
}
```

三个 getter 分别返回标准 `@opentelemetry/api` `Meter`、`Tracer` 和 `@opentelemetry/api-logs` `Logger`。
instrumentation scope name 使用 caller 的格式化 Plugin node address；同一 caller generation 重复读取返回同一实例。原生 instrument、span、
event、link、status、baggage、log body、severity、`eventName` 和 attributes 均不经过 Pluxel wrapper。active span 中直接 emit 的 log
会带上 trace/span correlation。

producer 仍须定义稳定的数据字典、attribute allowlist、基数和隐私预算。不要把 credential、完整 URL、stack、任意对象或无限集合 ID
放进 telemetry attributes/body。

## 输出配置

默认向 OTLP 推送 metrics、traces 和 logs，并关闭 Prometheus：

```ts
host.cfg(OtelPlugin).set({
	otlp: ['metrics', 'traces', 'logs'],
	prometheus: false,
})
```

`otlp` 可选择任意子集。Prometheus 只读取 metrics，也可以与 metrics OTLP push 同时开启：

```ts
host.cfg(OtelPlugin).set({
	otlp: ['metrics', 'traces', 'logs'],
	prometheus: { path: '/metrics' },
})
```

只做 Prometheus pull 时使用 `{ otlp: [], prometheus: {} }`。配置至少保留一个输出；被关闭的 signal 不加载 exporter、不读取它的
endpoint，也不会返回一个看似工作的 no-op API。访问关闭 signal 的 getter 会立即报错。

默认 pull URL 是显式产品协议 `GET /metrics`。它复用 Pluxel HTTP service，不启动第二个 listener。并发 scrape
合并为同一次 collection；OTLP periodic reader 与 Prometheus reader 相互独立。

## OTLP transports 与环境变量

每个启用 signal 都支持官方 OTel JS exporter 提供的三种协议：

- `grpc`（默认端口 4317）；
- `http/protobuf`（默认，端口 4318）；
- `http/json`（端口 4318）。

统一配置示例：

```text
OTEL_SERVICE_NAME=catalog
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example/otel
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20secret
OTEL_EXPORTER_OTLP_COMPRESSION=gzip
OTEL_EXPORTER_OTLP_TIMEOUT=10000
```

HTTP generic endpoint 会分别追加 `/v1/metrics`、`/v1/traces`、`/v1/logs`；gRPC endpoint 不追加 path。所有 generic 变量都可由
`OTEL_EXPORTER_OTLP_{METRICS|TRACES|LOGS}_{ENDPOINT|PROTOCOL|HEADERS|COMPRESSION|TIMEOUT}` 覆盖。signal-specific headers
与 generic headers 合并，同名 key 由 signal-specific 值覆盖。

官方 exporter 的 TLS/mTLS 环境变量同样生效：

- `OTEL_EXPORTER_OTLP_CERTIFICATE`、`CLIENT_KEY`、`CLIENT_CERTIFICATE`；
- 对应的 `OTEL_EXPORTER_OTLP_{SIGNAL}_...` signal-specific 形式；
- gRPC 的 generic/signal-specific `INSECURE`。

metrics reader 支持 `OTEL_METRIC_EXPORT_INTERVAL`、`OTEL_METRIC_EXPORT_TIMEOUT`；trace batching 支持 `OTEL_BSP_*`；log
batching 支持 `OTEL_BLRP_*`。queue、batch、delay、timeout、header、resource 和 endpoint 均有启动期硬上限。trace sampler 与 span
limits、metrics temporality/aggregation 等仍由上游 OTel SDK/exporter 标准环境变量控制。

无效配置使 Plugin 正常启动失败。后端暂时不可达只产生按 signal 限频的诊断，不反压 producer 热路径。官方 exporter 负责规范要求的
瞬时失败重试；durable queue、fan-out、复杂路由、认证策略和多 backend 应交给 OpenTelemetry Collector。

## VictoriaMetrics / VictoriaLogs

使用各产品要求的完整 signal endpoint 即可；已通过真实 OTLP/HTTP protobuf request 验证：

```text
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://victoriametrics:8428/opentelemetry/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://victorialogs:9428/insert/opentelemetry/v1/logs
```

VictoriaMetrics 的 Prometheus scrape 也可直接抓取 plugin-scoped `/metrics` route。生产部署仍需按 Victoria 版本启用相应 OTLP ingest
功能并配置租户/auth headers。

## 边界

- 不注册 global meter/tracer/logger provider；显式 constructor dependency 仍是 Plugin graph authority。
- 为 `startActiveSpan`、异步关联和标准传播安装一次 process-stable `AsyncLocalStorage` context manager，以及 W3C
  `tracecontext` + `baggage` propagator；已有 application-owned global coordinator 优先。
- 不自动转发 `ctx.logger`。RuntimeLogging 是 launcher-owned process logger，OTel Logger 是下游显式选择的原生 signal。
- OTLP Profiles 仍是 `v1development`，当前 OTel JS 没有 profiles API、SDK 或 exporter 包；本包不会伪造 no-op 支持。

资源所有权和 replacement/shutdown 细节见 [`DESIGN.md`](DESIGN.md)。
