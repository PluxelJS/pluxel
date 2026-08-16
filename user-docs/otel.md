# OpenTelemetry

`@pluxel/otel` 让 Plugin 直接使用标准 OpenTelemetry `Meter`、`Tracer` 和 `Logger`，并由一个普通 Plugin 生命周期统一管理
metrics、traces、logs 的 OTLP push，以及可选 Prometheus pull。

```ts
import { OtelPlugin } from '@pluxel/otel'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ displayName: 'Worker' })
class WorkerPlugin extends BasePlugin {
	constructor(private readonly otel: OtelPlugin) {
		super()
	}

	protected override init(): void {
		this.otel.meter.createCounter('worker.jobs').add(1)
		this.otel.tracer.startActiveSpan('worker.run', (span) => {
			this.otel.logger.emit({ body: 'worker started' })
			span.end()
		})
	}
}
```

三个对象都是原生 OTel API，scope name 自动使用 caller Plugin node identity。active span 可跨 Promise/async 边界，期间 emit 的 log 自动关联
trace/span ID。

默认配置向 OTLP 推送全部三个 signal：

```ts
host.cfg(OtelPlugin).set({
	config: {
		otlp: ['metrics', 'traces', 'logs'],
		prometheus: false,
	},
})
```

常用模式：

- 只开 logs：`{ otlp: ['logs'] }`；
- OTLP 全信号并增加 Prometheus：`{ otlp: ['metrics', 'traces', 'logs'], prometheus: {} }`；
- 只做 Prometheus pull：`{ otlp: [], prometheus: { path: '/metrics' } }`。

OTLP 支持 `grpc`、`http/protobuf`、`http/json`，并接受标准 generic 或 signal-specific endpoint、protocol、headers、timeout、
compression、TLS/mTLS 环境变量。VictoriaMetrics 与 VictoriaLogs 使用各自完整的 `.../v1/metrics`、`.../v1/logs` endpoint 即可。

Prometheus 默认 route 是显式产品协议 `GET /metrics`，复用已有 Pluxel HTTP service。Profiles 因 OTel JS
尚无 API/SDK/exporter 而暂不支持；`ctx.logger` 也不会被隐式转发。

完整环境变量、Victoria 示例、失败语义与架构边界见 [`../plugins/otel/README.md`](../plugins/otel/README.md)。
