---
title: OpenTelemetry
description: 为每个 Plugin 提供原生 Meter、Tracer 与 Logger，由宿主统一管理输出。
---

> `@pluxel/otel` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/otel` 直接向业务 Plugin 提供标准 OpenTelemetry `Meter`、`Tracer` 和 `Logger`，不另造一套遥测 API。宿主统一管理 provider、resource、exporter、上下文传播和生命周期，并保留每个调用方的身份。

## 先选择输出

默认配置启用三种 OTLP signal，关闭 Prometheus：

以下 `host` 是 [测试宿主](../development/testing.md)，用于验证装配。应用入口按 [添加插件](./index.md#把一个插件加入应用) 配置清单、配置记录和自动启动。

```ts no-twoslash
await host.start(OtelPlugin, {
	catalog: [CatalogPlugin],
	initialConfig: {
		otlp: ['metrics', 'traces', 'logs'],
		prometheus: false,
	},
})
await host.start(CatalogPlugin)
```

`otlp` 可以只包含所需 signal。Prometheus 只读取 metrics，也可以和 OTLP metrics 同时启用：

```ts no-twoslash
await host.start(OtelPlugin, {
	initialConfig: {
		otlp: ['traces', 'logs'],
		prometheus: { path: '/metrics' },
	},
})
```

只做 Prometheus pull：

```ts no-twoslash
await host.start(OtelPlugin, {
	initialConfig: {
		otlp: [],
		prometheus: {},
	},
})
```

至少要保留一个输出；`otlp: []` 与 `prometheus: false` 会在配置校验时失败。关闭的 signal 不加载对应 exporter，读取它的 getter 会立即报错，例如未启用 traces 时访问 `otel.tracer` 会抛出 `OpenTelemetry traces signal is disabled`。

Prometheus 默认直接在 `OtelPlugin` generation 的 `ctx.elysia` 上声明 `GET /metrics`，由宿主现有 carrier 提供服务，不启动第二个 listener。自定义 path 必须是非根、无 trailing slash、query、hash、反斜杠或空 segment 的最终绝对 Elysia path。并发 scrape 会合并为同一次 collection；失败返回 503，成功使用 Prometheus text format。

## 记录 metrics、trace 与 log

```ts twoslash
import type { Counter } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { OtelPlugin } from '@pluxel/otel'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Catalog' })
export class CatalogPlugin extends BasePlugin {
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

三个 getter 分别返回 `@opentelemetry/api` 的 `Meter`、`Tracer` 与 `@opentelemetry/api-logs` 的 `Logger`。instrumentation scope name 是 caller 的 Plugin node reference；同一 caller generation 重复读取同一个 getter 会返回同一实例。

span、event、link、status、baggage、log body、severity、`eventName` 和 attributes 都是原生 OTel contract。在 active span 内 emit 的 log 可获得 trace/span correlation。

上面的 `CatalogPlugin` 同时使用三种 signal：可使用默认 OTLP 配置，或 `otlp: ['traces', 'logs']` 加 `prometheus: {}`。调用 `refresh()` 后，Prometheus 输出应包含 `catalog_refreshes` 计数，Collector 中应出现 `catalog.refresh` span 和日志。若只开启 Prometheus，业务代码也只使用 `meter`，不调用关闭的 `tracer` 与 `logger`。

## 配置 OTLP endpoint

exporter 配置来自标准 OTel 环境变量，而不是 Plugin config：

```text
OTEL_SERVICE_NAME=catalog
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example/otel
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20secret
OTEL_EXPORTER_OTLP_COMPRESSION=gzip
OTEL_EXPORTER_OTLP_TIMEOUT=10000
```

支持 `grpc`、`http/protobuf`（默认）和 `http/json`。默认 endpoint 是：

- HTTP：`http://localhost:4318`；generic endpoint 会自动追加 `/v1/metrics`、`/v1/traces` 或 `/v1/logs`；
- gRPC：`http://localhost:4317`；endpoint 不追加 signal path。

每个 signal 都可用 `OTEL_EXPORTER_OTLP_{METRICS|TRACES|LOGS}_{ENDPOINT|PROTOCOL|HEADERS|COMPRESSION|TIMEOUT}` 覆盖 generic 值。generic 和 signal-specific headers 会合并，同名字段由 signal-specific 值覆盖。headers 使用逗号分隔的 percent-encoded `key=value` 形式。

TLS/mTLS 继续使用官方 exporter 的 `CERTIFICATE`、`CLIENT_KEY`、`CLIENT_CERTIFICATE` 变量及对应 signal-specific 形式；gRPC 还支持 `INSECURE`。URL 不允许携带 userinfo，认证应放在 header 或 TLS 配置中。

## Workbench 运维说明

Workbench 启用且 `OtelPlugin` 正常运行时，Plugin 会发布一个 host-rendered“运维说明” Content。除了 OTLP HTTP/gRPC
endpoint 规则、限频 diagnostics、Prometheus pull 与 secret/config 边界，它还显示 metrics、traces、logs exporter 和
Prometheus listener 的当前状态，并提供“立即导出待处理 telemetry”操作。

状态由 Plugin 领域变化触发 `dataChanged()`，Framework 在既有 Workbench WebSocket 与 Cap'n Web session 上重新读取并推送
最新完整状态；按钮同样通过这个 Content root 调用，不创建 OTel 专属 React/MF producer、SSE 或额外连接。页面不会显示
环境变量值、credential、完整 header 或未保存的 Config draft；Plugin 未运行时仍应通过 Config、启动 diagnostics 和日志恢复。

## resource、batch 与 sampling

runtime 用 host root name 作为默认 service name，并合并标准 OTel resource 环境变量。metrics periodic reader 接受 `OTEL_METRIC_EXPORT_INTERVAL` 与 `OTEL_METRIC_EXPORT_TIMEOUT`；trace batch processor 使用 `OTEL_BSP_*`；log batch processor 使用 `OTEL_BLRP_*`。

endpoint、headers、resource attributes、queue size、batch size、delay 和 timeout 都有启动期边界校验。非法环境变量会使 `OtelPlugin` lifecycle 失败，而不是悄悄退回另一套配置。

trace sampler、span limits、metrics temporality/aggregation 等仍使用上游 OTel SDK/exporter 的标准环境变量。本包不实现 durable queue、fan-out、复杂 routing 或多 backend；这些应由 OpenTelemetry Collector 承担。

## 数据建模

instrument 与 attribute name 是长期数据 contract。建议：

- counter 表示累计事件，histogram 表示分布，gauge/observable gauge 表示当前状态；
- attributes 使用稳定、低基数 allowlist，例如 `operation`、`result`、`region`；
- tenant ID、request ID、完整 URL、error message、stack 和任意对象不要进入 metric attributes；
- secret 不进入 attributes、log body、span event 或 resource；
- observable instrument 的 callback 要在 owner cleanup 中移除。

observable callback 应随 owner lifecycle 移除：

```ts no-twoslash
import type { ObservableCallback } from '@opentelemetry/api'

const workers = this.otel.meter.createObservableGauge('workers.active')
const observe: ObservableCallback = (result) => {
	result.observe(this.workerCount, { region: 'hk' })
}
workers.addCallback(observe)
this.ctx.effects.defer(() => workers.removeCallback(observe))
```

## context 与生命周期

当 traces 或 logs 启用时，runtime 会安装 process-stable `AsyncLocalStorageContextManager`，以及 W3C `tracecontext` + `baggage` propagator；已有 application-owned global coordinator 优先。本包不会注册 global meter/tracer/logger provider，constructor dependency 仍是 Plugin graph authority。

provider stop/replacement 时会关闭 meter、tracer 和 logger providers，flush/shutdown 对应 readers 与 processors。OTLP 后端暂时不可达时，producer 热路径不会被反压；失败按 signal 限频写入 `ctx.logger`，恢复时记录 recovery。官方 exporter 负责其标准瞬时重试。

`ctx.logger` 不会自动转发到 OTel Logger：前者是 launcher-owned process logging，后者是 consumer 显式选择的 telemetry signal。业务记录 telemetry 不依赖 Workbench。

OTLP Profiles 仍属于 OpenTelemetry `v1development`，当前 OTel JS 没有对应稳定 API、SDK 或 exporter；本包不提供伪造的 no-op profiles 支持。
