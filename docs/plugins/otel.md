---
title: OpenTelemetry
description: 为每个 Plugin 提供原生 Meter、Tracer 与 Logger，由宿主统一管理输出。
---

> `@pluxel/plugin-otel` 目前只供 Pluxel 工作区使用，尚不是公开安装入口。完整边界见 [Package 矩阵](../reference/package-matrix.md)。

`@pluxel/plugin-otel` 的抽象 `Otel` 向业务 Plugin 提供标准 OpenTelemetry `Meter`、`Tracer` 和 `Logger`。应用可以选择 `OtelPlugin` 的 OTLP/Prometheus 预设，也可以直接装配原生 SDK providers；两条路径共享调用方身份、上下文传播和 generation 生命周期。

## 默认预设选择输出

`OtelConfig` 从根入口导出，部署环境可绑定输出选择；Workbench 只是可选状态与手动 flush 面板：

```ts no-twoslash
import { envBinding } from '@pluxel/host'
import { OtelPlugin, OtelConfig } from '@pluxel/plugin-otel'

// 应用 envBindings 数组的一项；两项都使用 JSON 值。
envBinding(OtelPlugin, {
	config: {
		schema: OtelConfig,
		mapping: {
			otlp: 'TELEMETRY_SIGNALS',
			prometheus: 'TELEMETRY_PROMETHEUS',
		},
	},
})
// TELEMETRY_SIGNALS=[]
// TELEMETRY_PROMETHEUS={"path":"/metrics"}
```

Plugin config 遵循 [Host 输入绑定](../host/configuration.md#绑定部署环境与-json-文件) 的来源优先级。没有独立的持久化 telemetry profile 覆盖该配置。

默认配置启用三种 OTLP signal，关闭 Prometheus：

以下 `host` 是 [测试宿主](../plugin-development/testing.md)，用于验证装配。应用入口按 [添加插件](./index.md#把一个插件加入应用) 配置清单、配置记录和自动启动。

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

Prometheus 默认直接在 `OtelPlugin` generation 的 `ctx.require(ElysiaApp)` 上声明 `GET /metrics`，由宿主现有 carrier 提供服务，不启动第二个 listener。自定义 path 必须是非根、无 trailing slash、query、hash、反斜杠或空 segment 的最终绝对 Elysia path。并发 scrape 会合并为同一次 collection；失败返回 503，成功使用 Prometheus text format。

## 记录 metrics、trace 与 log

```ts twoslash
import type { Counter } from '@opentelemetry/api'
import { SeverityNumber } from '@opentelemetry/api-logs'
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

三个 getter 分别返回 `@opentelemetry/api` 的 `Meter`、`Tracer` 与 `@opentelemetry/api-logs` 的 `Logger`。instrumentation scope name 是 caller 的 Plugin node reference；同一 caller generation 重复读取同一个 getter 会返回同一实例。

span、event、link、status、baggage、log body、severity、`eventName` 和 attributes 都是原生 OTel contract。在 active span 内 emit 的 log 可获得 trace/span correlation。

上面的 `CatalogPlugin` 同时使用三种 signal：可使用默认 OTLP 配置，或 `otlp: ['traces', 'logs']` 加 `prometheus: {}`。调用 `refresh()` 后，Prometheus 输出应包含 `catalog_refreshes` 计数，Collector 中应出现 `catalog.refresh` span 和日志。若只开启 Prometheus，业务代码也只使用 `meter`，不调用关闭的 `tracer` 与 `logger`。

## 直接装配原生 providers

需要自定义 sampler、metric views、resource、readers、多个 processors 或 exporter 时，实现 `@Plugin(Otel)` 并覆盖 `createProviders()`。返回值 `OtelProviders` 只包含原生 `meterProvider`、`tracerProvider`、`loggerProvider`，SDK 参数直接交给各 provider 的构造函数。框架不复制这些参数，也不读取全局 providers。

下面的最短实现只提供 traces；业务只使用 `otel.tracer`。`SimpleSpanProcessor` 在 provider 创建失败时由 hook 清理，成功交付后由 generation 关闭：

```ts no-twoslash
import { Plugin } from '@pluxel/core'
import { Otel, type OtelProviders } from '@pluxel/plugin-otel'
import {
	BasicTracerProvider,
	ConsoleSpanExporter,
	SimpleSpanProcessor,
	TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base'

@Plugin(Otel)
export class ApplicationOtel extends Otel {
	protected override async createProviders(): Promise<OtelProviders> {
		const processor = new SimpleSpanProcessor(new ConsoleSpanExporter())
		try {
			return {
				tracerProvider: new BasicTracerProvider({
					sampler: new TraceIdRatioBasedSampler(0.25),
					spanProcessors: [processor],
				}),
			}
		} catch (error) {
			try {
				await processor.shutdown()
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'Telemetry initialization failed', {
					cause: error,
				})
			}
			throw error
		}
	}
}
```

部署清单选择 `ApplicationOtel`，业务 constructor 继续依赖 `Otel`。若同时登记多个实现，使用 [provider default](../plugin-development/testing.md#抽象-provider-与-consumer-override) 明确选择。自定义实现不继承 `OtelPlugin`，无需声明 `OtelConfig` 或填写假的 OTLP 输出。

`createProviders()` 在本 generation 的配置注入后调用一次。缺失 provider 对应的 getter 报 signal disabled；空 record 会使启动失败。返回前发生失败时，hook 负责关闭已创建资源；返回后框架拥有所有 provider 的 flush/shutdown，不能交付借用的全局 provider。停止后旧调用方入口失效，SDK instruments 本身仍遵循上游停止契约。

例如 metrics 原生 `MeterProvider({ readers, views })` 可控制 instrument 选择、名称、attributes、aggregation 和 histogram buckets；trace 的 `sampler`、`spanLimits`、`spanProcessors` 与 log 的 `processors`、`loggerConfigurator` 继续使用上游类型。参考 [原生 metric views](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/metrics.md#configuring-metric-views) 和 [原生 tracer 配置](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-trace-base.html)。

## 配置 OTLP endpoint

默认 `OtelPlugin` 的 exporter 配置来自标准 OTel 环境变量，而不是 Plugin config；自定义 hook 的配置由应用代码决定：

这些 `OTEL_*` 由 SDK/插件从进程 `process.env` 读取；它们不是 Host `startup.env` 的自动映射。嵌入式宿主只传入自定义 `startup.env` 不会替换 SDK 的进程环境。部署应在启动 Node 前设置它们，认证仍使用标准 OTel headers/mTLS，不复制到普通 Plugin 配置或 Workbench。

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

默认预设提供只读输出状态和“立即导出待处理 telemetry”操作。页面显示 exporter / Prometheus 状态，
不显示 endpoint、环境变量、header 或 credential；Plugin 未运行时从 Config、启动 diagnostics 和日志恢复。
Workbench 关闭不影响 telemetry。

自定义 provider 只显示 `external`，表示 provider 已安装、exporter 健康由应用观测；不会由预设配置推断为 healthy 或 waiting。缺失 provider 显示 disabled，Prometheus 只有实际挂载预设 reader 的路由才显示 listening。手动 flush 等待全部 providers；任一失败返回失败结果。

自定义 concrete Plugin 若需要同一面板，在自己的 `init()` 中先调用 base，再用公开 `OtelWorkbench` 和受保护的 `workbenchOperations()` 发布：

```ts no-twoslash
import { OtelWorkbench } from '@pluxel/plugin-otel'

// ApplicationOtel 内的方法；无需面板时省略。
protected override async init(): Promise<void> {
	await super.init()
	this.ctx.workbench?.publish(OtelWorkbench, {
		operations: (context) => this.workbenchOperations(context),
	})
}
```

## resource、batch 与 sampling

runtime 用 host root name 作为默认 service name，并合并标准 OTel resource 环境变量。metrics periodic reader 接受 `OTEL_METRIC_EXPORT_INTERVAL` 与 `OTEL_METRIC_EXPORT_TIMEOUT`；trace batch processor 使用 `OTEL_BSP_*`；log batch processor 使用 `OTEL_BLRP_*`。

endpoint、headers、resource attributes、queue size、batch size、delay 和 timeout 都有启动期边界校验。非法环境变量会使 `OtelPlugin` lifecycle 失败，而不是悄悄退回另一套配置。

默认预设保留上游 trace sampler 等标准环境变量；更完整的 SDK 选项与多 reader/processor/exporter 组合使用原生 provider hook。跨进程的 durable queue、routing 与后端治理可交给 OpenTelemetry Collector。

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

provider stop/replacement 时会关闭 meter、tracer 和 logger providers，flush/shutdown 对应 readers 与 processors。关闭会尝试全部 providers 并等待结果，重复关闭复用同一结果；失败进入 lifecycle 报告，初始化与清理同时失败保留在 `AggregateError`。默认 OTLP 后端暂时不可达时，producer 热路径不会被反压；失败按 signal 限频写入 `ctx.logger`，恢复时记录 recovery。官方 exporter 负责其标准瞬时重试。

需要导出 `ctx.logger` 时，在 Host 配置[原生 LogTape OTel sink](../host/configuration.md#远程输出原生-logtape-sink)，无需安装本 Plugin。

`ctx.logger` 不会自动转发到 OTel Logger：前者是 launcher-owned process logging，后者是 consumer 显式选择的 telemetry signal。业务记录 telemetry 不依赖 Workbench。

OTLP Profiles 仍属于 OpenTelemetry `v1development`，当前 OTel JS 没有对应稳定 API、SDK 或 exporter；本包不提供伪造的 no-op profiles 支持。
