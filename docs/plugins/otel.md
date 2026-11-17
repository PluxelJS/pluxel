---
title: OpenTelemetry
description: 为每个 Plugin 提供原生 Meter、Tracer 与 Logger，由宿主统一管理输出。
---

> `@pluxel/plugin-otel` 目前主要供 Pluxel 工作区内使用。完整包状态见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/plugin-otel` 向业务插件提供标准 OpenTelemetry 的 `Meter`、`Tracer` 和 `Logger` 抽象。宿主可以通过预设的 `OtelPlugin` 快速配置 OTLP 或 Prometheus 导出，也可以直接装配原生 SDK Provider。

## 快速配置导出目标

通过 `OtelConfig` 可配置输出的遥测信号（Metrics、Traces、Logs）或 Prometheus 端点：

```ts no-twoslash
import { envBinding } from '@pluxel/host'
import { OtelPlugin, OtelConfig } from '@pluxel/plugin-otel'

envBinding(OtelPlugin, {
	config: {
		schema: OtelConfig,
		mapping: {
			otlp: 'TELEMETRY_SIGNALS',
			prometheus: 'TELEMETRY_PROMETHEUS',
		},
	},
})
```

默认情况下，`OtelPlugin` 会启用三种 OTLP 信号并关闭 Prometheus：

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

按需定制导出组合：

```ts no-twoslash
// 仅导出 Traces 和 Logs，并开启 Prometheus 指标抓取接口
await host.start(OtelPlugin, {
	initialConfig: {
		otlp: ['traces', 'logs'],
		prometheus: { path: '/metrics' },
	},
})

// 仅开启 Prometheus 抓取
await host.start(OtelPlugin, {
	initialConfig: {
		otlp: [],
		prometheus: {},
	},
})
```

- Prometheus 抓取端点默认挂载在宿主 Elysia 实例的 `GET /metrics` 路由上，复用现有 HTTP 端口。
- 未启用的信号不会初始化对应的 Exporter，如果在业务插件中访问未启用的 Getter（如未开启 traces 时访问 `otel.tracer`），将抛出明确的异常。

## 记录 Metrics、Trace 与 Log

在业务插件中注入 `Otel` 抽象类：

```ts twoslash
import { SeverityNumber, type Counter } from '@opentelemetry/api'
import { Otel } from '@pluxel/plugin-otel'
import { BasePlugin, Plugin } from '@pluxel/core'

@Plugin({ displayName: 'Catalog' })
export class CatalogPlugin extends BasePlugin {
	private refreshed!: Counter

	constructor(private readonly otel: Otel) {
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

- `otel.meter`、`otel.tracer` 和 `otel.logger` 分别返回 `@opentelemetry/api` 原生实例。
- Scope 名称会自动绑定为当前插件名称。
- 在活跃的 Span 内发送日志时，日志会自动关联对应的 Trace ID 与 Span ID。

## 装配原生 Provider

若需要配置自定义 Sampler、Metric Views 或复合 Processor，可通过继承 `@Plugin(Otel)` 并重写 `createProviders()` 来直接注入原生 SDK Provider：

```ts no-twoslash
import { Plugin } from '@pluxel/core'
import { Otel, type OtelProviders } from '@pluxel/plugin-otel'
import {
	TracerProvider,
	ConsoleSpanExporter,
	SimpleSpanProcessor,
	TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace'

@Plugin(Otel)
export class ApplicationOtel extends Otel {
	protected override async createProviders(): Promise<OtelProviders> {
		const processor = new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() })
		try {
			return {
				tracerProvider: new TracerProvider({
					sampler: new TraceIdRatioBasedSampler(0.25),
					spanProcessors: [processor],
				}),
			}
		} catch (error) {
			await processor.shutdown().catch(() => {})
			throw error
		}
	}
}
```

业务插件依然声明注入 `Otel`，由宿主清单装配具体的 `ApplicationOtel` 实现。

## 配置 OTLP 环境变量

默认的 `OtelPlugin` 支持读取 OpenTelemetry 官方标准环境变量：

```text
OTEL_SERVICE_NAME=catalog
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example/otel
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20secret
OTEL_EXPORTER_OTLP_COMPRESSION=gzip
OTEL_EXPORTER_OTLP_TIMEOUT=10000
```

- 协议支持 `grpc`、`http/protobuf`（默认）以及 `http/json`。
- 默认端点为 `http://localhost:4318`（HTTP）或 `http://localhost:4317`（gRPC）。
- 支持各类标准的细粒度信号变量，如 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_TRACES_SAMPLER` 等。

## Workbench 运维支持

在启用 Workbench 控制台的应用中，`OtelPlugin` 会注册只读的遥测状态面板，并支持触发手动 Flush 操作，便于在控制台即时查看 Exporter 状态与导出数据。

## 上下文与生命周期

- 当启用 Traces 或 Logs 时，插件系统会自动配置基于 `AsyncLocalStorageContextManager` 的上下文传播及 W3C Trace Context 协议。
- 插件系统关闭或重载时，会依次触发所有 Provider 的 Flush 与 Shutdown，确保内存中未发送的 Span 和 Log 正常投递。
- 若只需收集宿主系统的控制台输出与日志，可在宿主层配置 [LogTape 原生 OTel Sink](../host/configuration.md#远程输出原生-logtape-sink)。
