# Metrics 官方插件提案

> 状态：提案，尚未实现。本文只确定首版产品与架构边界，不定义当前 API。

## 目标

为插件 operation 提供实用的 RED metrics：调用量、错误量和耗时分布。插件作者不需要直接处理 Prometheus/
OpenTelemetry SDK、metric naming、attribute 基数、HMR cleanup 或 exporter lifecycle。

Autometrics 的 wrapper/decorator 体验值得借鉴，但 Pluxel 的实现必须服从 caller Context、plugin effects 和现有 HTTP
边界，不能使用 module-global provider、独立监听端口或 source path label。

## 首版决策

- 新能力是 `plugins/metrics` 中的官方可选插件 `@pluxel/metrics`，不是常驻 Context service。
- consumer required-depend `Metrics`；官方 `MetricsPlugin` 提供实现。
- 作者只有 `metrics.measure()` 和 `@Measured()` 两个入口。
- 部署显式选择一个输出：`otlp-http` 或 `prometheus`。
- 生产推荐 OTLP/HTTP 发往 OpenTelemetry Collector；Prometheus pull 适合本地、单机或已有 scrape 部署。
- 应用不同时启用两个输出。多 backend、认证、队列与 fan-out 交给 Collector。
- 不公开 Counter、Histogram、attributes、registry、MeterProvider 或 exporter/backend adapter。
- 不修改 core/runtime/toolchain，不依赖 Workbench。

## 作者 API

默认入口只导出：

```ts
export { Metrics, MetricsPlugin, MetricsConfig, Measured }
export type { MeasuredOptions, MetricsPluginConfig }
```

### 显式测量

```ts
export abstract class Metrics extends BasePlugin {
	abstract measure<T>(operation: string, run: () => PromiseLike<T>): Promise<T>
	abstract measure<T>(operation: string, run: () => T): T
}
```

```ts
@Plugin({ name: 'CatalogPlugin' })
class CatalogPlugin extends BasePlugin {
	constructor(readonly metrics: Metrics) {
		super()
	}

	refresh() {
		return this.metrics.measure('refresh', () => this.loadCatalog())
	}
}
```

`measure()` 保留同步返回类型。callback 返回 Promise/thenable 时测量 settlement；返回值、throw value 和 rejection
reason 不变。

### 方法 decorator

```ts
export type MeasuredOptions = Readonly<{
	/** Defaults to the decorated string method key. */
	name?: string
}>

export function Measured(options: MeasuredOptions = {}): MethodDecorator
```

```ts
@Plugin({ name: 'CatalogPlugin' })
class CatalogPlugin extends BasePlugin {
	constructor(readonly metrics: Metrics) {
		super()
	}

	@Measured()
	async refresh() {
		// ...
	}

	@Measured({ name: 'catalog.lookup' })
	lookup(id: string) {
		// ...
	}
}
```

`@Measured()` 使用现有 `pluginMethodDecorator(Metrics, ...)` 取得 caller-bound provider。constructor 仍是 required
dependency 的唯一声明；缺失 dependency 时沿用现有 graph validation 失败。

Decorator 首版只支持 method。symbol method 必须显式给出 `name`；不自动遍历或包裹整个 class。

### Operation identity

一个 operation 的身份固定为：

```text
(caller plugin canonical ID, operation name)
```

plugin ID 从 caller Context 取得，作者不能覆盖。operation 是作者选择的稳定、低基数字符串；不加入 module path、class
name、argument、URL、user/tenant ID 或 error 内容。

## 测量语义

一次 operation completion 恰好记录：

- 一个 call，`result = ok | error`；
- 一个 duration observation。

同步 throw 和 Promise rejection 是 `error`，其他返回值都是 `ok`。`{ ok: false }`、HTTP 4xx/5xx、iterator、stream
等 domain 语义不会被猜测。Generator/stream 只测量对象创建，不测量后续消费。

永久 pending 的 Promise 不产生 completion metric。达到 operation 上限时业务 callback 继续执行但不测量；
instrumentation/export failure 也不能改变业务结果。

不提供 no-op `Metrics` provider。禁用 provider 时 required consumers 按正常 graph 语义阻塞。

## Metric contract

| 含义                    | OTLP instrument                        | Prometheus metric                            | Attributes                      |
| ----------------------- | -------------------------------------- | -------------------------------------------- | ------------------------------- |
| completed calls         | `pluxel.operation.calls`               | `pluxel_operation_calls_total`               | `plugin`, `operation`, `result` |
| completed call duration | `pluxel.operation.duration`, unit `s`  | `pluxel_operation_duration_seconds`          | `plugin`, `operation`           |
| capacity drops          | `pluxel.metrics.operation_limit.drops` | `pluxel_metrics_operation_limit_drops_total` | none                            |

`result` 只有 `ok | error`。Duration 使用固定 explicit buckets。首版不接受 arbitrary attributes，也不会把 argument、
return value、error、request 或 source path 写进 telemetry。

OTLP 的应用身份使用 Resource `service.name`：`OTEL_SERVICE_NAME` 优先，否则使用 `ctx.root.name`。直接 Prometheus pull 的
job/instance identity 由 scrape deployment 配置。

## 配置

```ts
export type MetricsPluginConfig = Readonly<{
	exporter:
		| Readonly<{
				type: 'otlp-http'
				/** Full metrics endpoint; otherwise use standard OTel environment variables. */
				endpoint?: string
		  }>
		| Readonly<{
				type: 'prometheus'
				/** @defaultValue '/metrics' */
				path?: string
		  }>
	durationBucketsSeconds?: readonly number[]
	/** @defaultValue 1024 */
	maxOperations?: number
}>
```

Exporter 必须显式选择，不根据 `NODE_ENV` 推断，也不在失败时自动切换模式。

默认 buckets：

```ts
const DEFAULT_DURATION_BUCKETS_SECONDS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const
```

配置使用 strict discriminated schema。OTLP endpoint 必须是 `http:`/`https:` URL；Prometheus path 必须是非 root
absolute path。Buckets 必须 finite、positive、strictly increasing；`maxOperations` 为 1–10,000，默认 1,024。

配置不保存 auth header/token。OTLP transport、header、timeout、interval 与 resource attributes 使用标准 OTel
environment variables，例如：

- `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`；
- `OTEL_EXPORTER_OTLP_METRICS_HEADERS` / `OTEL_EXPORTER_OTLP_HEADERS`；
- `OTEL_METRIC_EXPORT_INTERVAL` / `OTEL_METRIC_EXPORT_TIMEOUT`；
- `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES`。

## 部署

### 推荐：OTLP/HTTP

```ts
{
	exporter: { type: 'otlp-http' },
}
```

```text
MetricsPlugin -> OTLP/HTTP protobuf -> OpenTelemetry Collector -> backends
```

插件拥有 local `MeterProvider` 和一个 periodic reader，不安装 global OTel provider。Collector 不可达不会阻塞业务调用；
export 是 best-effort，应用内不建立 durable queue。Provider teardown 在有界时间内完成最后一次 flush/shutdown。

OTLP 内部固定使用 delta temporality。OpenTelemetry synchronous instrument 没有删除 attribute set 的 API；delta 可以让
停止或 HMR-replaced operation 在下一次 collection 后不再持续占用历史 aggregation。这个选择是 lifecycle 约束，不作为
public 调优项。

### 可选：Prometheus pull

```ts
{
	exporter: { type: 'prometheus', path: '/metrics' },
}
```

插件使用 package-owned registry，通过 `ctx.http.plugin` 挂载 route，不创建新 listener，不使用 global registry，也不
采集 process default metrics。Endpoint 认证与网络暴露由部署边界负责。

同一时刻的并发 scrape 可以共享一次 serialization；serialization failure 返回 503，不影响插件业务能力。

## 实现与生命周期边界

`MetricsPlugin` 内部按 config 创建一个 package-private recorder：

```text
MetricsPlugin
  ├─ OtlpRecorder
  └─ PrometheusRecorder
```

这是内部组成，不是 public backend extension point。未选择的 mode 不创建 registry、reader、timer、route 或 transport。

每个 caller generation 拥有自己的 operation registrations，并通过 caller effects 清理：

- consumer stop/rollback/replacement 使旧 view 失效并归还 capacity；
- Prometheus mode 立即删除对应 label series；
- OTLP mode 立即释放 Pluxel registration，SDK 的 interval state 在后续 delta collection 后消失；
- provider stop/replacement 清理选中的 recorder 和全部剩余 owner state；
- disabled provider 不创建任何 metrics backend resource。

旧 generation 已开始但 cleanup 后才 settle 的 async operation 保留原业务结果，但不再记录到失效 recorder。

## 基数与性能

热路径只做 owner/operation lookup、monotonic clock、一次 counter increment 和一次 histogram observation。同步路径不创建
Promise；不使用 AsyncLocalStorage、stack capture、argument serialization 或 per-call log。

设 operation 数为 `N`、bucket 数为 `B`，直接 Prometheus pull 的 series 上界约为：

```text
2N + (B + 3)N + 1 = (B + 5)N + 1
```

默认 `B = 13`、`N <= 1024`，最坏约 18,433 series。达到 cap 后不创建带 operation 的 overflow series，不扫描或淘汰
活跃 operation。

## 首版明确不做

- raw counter/gauge/histogram API 或 arbitrary attributes；
- public exporter/backend/reader adapter；
- exporter array 或应用内 OTLP + Prometheus 双写；
- process、HTTP、commands、plugin lifecycle 的自动 instrumentation；
- class-wide/transform-time 自动包裹；
- SLO、dashboard、alert rule、Workbench 页面或 IDE integration；
- metrics 专用 listener、认证系统或持久队列。

## 首版验收

- 两个真实 consumer 能自然使用 `measure()` / `@Measured()`。
- OTLP payload 与 Prometheus scrape 符合固定 metric contract。
- sync/async success/error completion 恰好记录一次且不改变业务结果。
- consumer rollback、HMR replacement 和 provider teardown 不留下持续增长的 owner/series state。
- OTLP Collector failure、Prometheus route collision、scrape failure 和 disabled provider 都有诚实行为。
- 两种 mode 通过真实 Vite Module Runner、static packaging、集成测试和 hot-path/heap benchmark。
- 实现只使用公开 `@pluxel/runtime` API；完成后同步 package README 与 `user-docs/`，并删除本 proposal。

后续是否加入 domain-result error classification、OTLP/gRPC、raw business metrics 或 Workbench 体验，只由真实 consumer
需求决定，不在首版预留抽象。
