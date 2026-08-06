# Operation Metrics

`@pluxel/metrics` 为 Plugin operation 提供调用量、throw/reject 错误量和耗时。标准写法只有 constructor dependency 加
`measure()`：

```ts
import { MetricsPlugin } from '@pluxel/metrics'

constructor(private readonly metrics: MetricsPlugin) {
	super()
}

refresh() {
	return this.metrics.measure('catalog.refresh', () => this.loadCatalog())
}
```

同步 callback 保持同步返回，Promise/thenable 测量到 settlement。只有 throw/reject 是通用 error；业务返回值、HTTP status、
cache miss 或 rate denial 不会被猜测。operation 使用稳定、低基数名称，不能包含参数、URL、用户/租户/对象 ID 或错误内容。

Host 装配 `MetricsPlugin` 后，通过标准 OTel 环境变量指向 Collector：

```text
OTEL_SERVICE_NAME=my-service
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://collector.example/v1/metrics
```

应用内只有 OTLP/HTTP protobuf 出口。Prometheus、认证重试、队列和多 backend 放在 Collector；Collector 暂时不可达不会改变
Plugin 的业务结果。完整 metric contract、环境变量、容量和失败语义见
[`../plugins/metrics/README.md`](../plugins/metrics/README.md)。
