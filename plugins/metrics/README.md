# `@pluxel/metrics`

Pluxel 官方 OTLP-first operation RED metrics 插件。插件作者只需用 `measure(operation, run)` 包住一次操作；调用量、
throw/reject 错误量和耗时由 `MetricsPlugin` 聚合，并通过 OTLP/HTTP protobuf 发往 OpenTelemetry Collector 或兼容后端。

## 使用

把 `MetricsPlugin` 与 consumer 一起装入 host，并在 consumer constructor 中声明 required dependency：

```ts
import { MetricsPlugin } from '@pluxel/metrics'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'CatalogPlugin' })
class CatalogPlugin extends BasePlugin {
	constructor(private readonly metrics: MetricsPlugin) {
		super()
	}

	refresh() {
		return this.metrics.measure('catalog.refresh', () => this.loadCatalog())
	}
}

host.add([MetricsPlugin, CatalogPlugin])
```

`measure()` 保持 callback 的业务语义：同步 callback 仍同步返回；Promise/thenable fulfillment 返回原值；同步 throw 和
rejection 保留原错误。只有 throw/reject 记为 `error`，`{ ok: false }`、cache miss、rate denial 或 HTTP status 不会被猜成
错误。

operation 必须是没有首尾空白、控制字符或未配对 surrogate 的非空稳定字符串，最长 128 UTF-8 bytes。不要放入 URL、
argument、user/tenant/object ID、error message 或其他动态值。无效 operation 会在 callback 执行前抛出 `TypeError`。

## 部署

最小生产配置：

```text
OTEL_SERVICE_NAME=my-service
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://collector.example/v1/metrics
```

本地未配置 endpoint 时默认发送到 `http://localhost:4318/v1/metrics`。需要认证时使用
`OTEL_EXPORTER_OTLP_METRICS_HEADERS`，例如 `Authorization=Bearer%20token`；不要把 credential 放入 endpoint URL。

支持的标准环境变量：

| 变量                                  | 行为                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 完整 metrics endpoint，优先级最高                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | generic endpoint；自动在 path 后追加 `/v1/metrics`                    |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS`  | metrics headers，优先级高于 generic headers                           |
| `OTEL_EXPORTER_OTLP_HEADERS`          | generic headers                                                       |
| `OTEL_SERVICE_NAME`                   | OTel resource `service.name`                                          |
| `OTEL_RESOURCE_ATTRIBUTES`            | 逗号分隔、percent-encoded 的 `key=value` resource attributes          |
| `OTEL_METRIC_EXPORT_INTERVAL`         | export interval，默认 `60000` ms，范围 1,000–300,000                  |
| `OTEL_METRIC_EXPORT_TIMEOUT`          | export timeout，默认 `30000` ms，范围 100–30,000，且不得大于 interval |
| `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | 只接受 `http/protobuf`                                                |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | generic protocol fallback，同样只接受 `http/protobuf`                 |

环境变量在 `MetricsPlugin` 启动时一次读取。URL、headers、resource attributes 和时间参数不合法会使 provider 启动失败；
required consumers 随正常 graph validation 阻塞。Collector 暂时不可达只会丢失当前 interval，不会反压或改变业务调用。

应用只输出 OTLP。需要 Prometheus、认证重试、持久队列、fan-out 或多个 backend 时在 Collector 中配置：

```text
MetricsPlugin -> OTLP/HTTP protobuf -> Collector -> Prometheus / observability backend
```

## 固定 metric contract

| Instrument                             | Unit     | Attributes                                                                       |
| -------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `pluxel.plugin.operation.calls`        | `{call}` | `pluxel.plugin.id`, `pluxel.operation.name`, `pluxel.operation.result=ok\|error` |
| `pluxel.plugin.operation.duration`     | `s`      | `pluxel.plugin.id`, `pluxel.operation.name`                                      |
| `pluxel.metrics.operation_limit.drops` | `{drop}` | `pluxel.metrics.limit=total\|per_plugin`                                         |

Duration 使用固定 explicit buckets：`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60`
秒。Temporality 固定为 delta。

一个 provider 最多保留 1,024 个 operation identity，每个 caller Plugin 最多 128 个。达到上限时 callback 仍正常执行，
但该次 measurement 被丢弃并增加 capacity-drop metric。容量、buckets 和 temporality 不提供应用配置，避免每个部署形成不同
的数据字典。

生命周期、SDK 隔离、基数边界和验证依据见 [`DESIGN.md`](DESIGN.md)。
