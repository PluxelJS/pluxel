# OpenTelemetry 插件设计

## 决策

`@pluxel/plugin-otel` 是 OTel SDK 的 Pluxel 生命周期装配层。业务 constructor 依赖 abstract `Otel`，读取三个 caller-scoped getter；
concrete `@Plugin(Otel)` 通过 `createProviders(): Promise<OtelProviders>` 交付原生 SDK providers。`OtelPlugin` 是可选的默认预设：

| Contract | 原生类型                      | instrumentation scope                 |
| -------- | ----------------------------- | ------------------------------------- |
| `meter`  | `@opentelemetry/api` `Meter`  | caller Plugin node address projection |
| `tracer` | `@opentelemetry/api` `Tracer` | caller Plugin node address projection |
| `logger` | `@opentelemetry/api` `Logger` | caller Plugin node address projection |

Plugin 不拥有 instrument/span/log 数据模型，不包装热路径，不猜测业务结果。events 使用原生
OTel Logger 的 `eventName`，而不是增加第四套 event API。

原生装配直接使用 `MeterProvider`、`TracerProvider`、`LoggerProvider` 的完整构造参数和组合能力。`OtelProviders` 只接受对应
provider 实例；不为 sampler、views、readers、processors、limits、resource 或 exporter options 增加平行配置类型。未交付的 signal 报 disabled，
空 record 明确拒绝。hook 在本 generation 的配置注入后调用一次，交付前失败由 hook 清理；交付后全部 providers 归 generation，
不可借用进程全局 provider。

默认预设的普通 field `configs.use(OtelConfig)` 声明持久配置：

```ts
type OtelPluginConfig = {
	otlp: Array<'metrics' | 'traces' | 'logs'>
	prometheus: false | { path: string }
}
```

默认 `otlp` 启用三个 signal，Prometheus 关闭。`otlp` 可为空，但此时必须开启 Prometheus。Prometheus 只属于 metrics；它不是一个
OTLP signal。

## 运行时结构

默认 `OtelPlugin` generation 共享一个 resource，并分别拥有 local provider；自定义 concrete provider 可以使用原生 resource、
sampler、metric views 和多个 reader/processor/exporter：

```text
caller.meter  -> MeterProvider  -> PeriodicMetricReader -> signal OTLP exporter
                              `-> PrometheusPullReader -> Pluxel plugin HTTP route

caller.tracer -> TracerProvider -> BatchSpanProcessor -> signal OTLP exporter

caller.logger -> LoggerProvider -> BatchLogRecordProcessor -> signal OTLP exporter
```

每个 OTLP exporter 按 signal 独立解析 endpoint/protocol/headers/timeout/compression，并动态加载 `grpc`、`http/protobuf` 或
`http/json` 官方 exporter 包。关闭的 signal 不解析环境变量、不构造 provider/processor/exporter。metrics 的两个 reader 独立
collection，Prometheus scrape 不等待 push interval。

不注册 global OTel provider。一个进程可运行多个 Host、测试 Host 和 replacement generation；global provider 的 write-once contract
会让其中一个 generation 意外取得永久 authority。constructor required dependency 使 activation、verification、stop、rollback 和
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
关闭全部已取得资源并保留原始错误；初始化与清理同时失败用 `AggregateError` 保留两者。成功后只注册一次 owner effect。
公开 runtime 在 stop 时先撤销，随后幂等 shutdown/flush 三个 provider。一个 provider 失败不会跳过其他 provider，shutdown
失败仍进入 lifecycle report，不能仅记录 warning 后伪装成功。

metrics periodic reader、BSP 和 BLRP 都有有界 batch/queue/delay/export timeout。BLRP 上游当前不读取 `OTEL_BLRP_*`，因此本包显式
解析后传入 SDK；BSP 也显式传入以统一限制与测试隔离。官方 exporter 自己实现 OTLP transient retry。

export 诊断包装器保留原生 exporter 语义，只上报 `{ signal, ok }` 或 bounded `errorType`。首次失败、每分钟持续失败窗口和恢复按
signal 分开记录；不会记录 endpoint、headers、payload、response 或任意业务 attributes。Prometheus collection error 返回 503。

默认 SDK 工厂内部登记返回 record 的受管 OTLP/Prometheus 事实，adapter 按实际 provider 对象与该 receipt 匹配，
不通过 hook 方法 identity 或保存配置推断实际输出。自定义 record 的 provider 状态是 `external`，只证明已安装，不声称 exporter
健康；缺失 provider 为 disabled。Prometheus 仅在实际 reader 已挂载路由时显示 listening。

可选 Workbench Content 由 concrete Plugin 在自己的 `init()` 中发布；abstract `Otel` 提供受保护的 `workbenchOperations()`，
默认和自定义实现可复用公开 `OtelWorkbench` descriptor。Content 复用同一份 export state，只保留每个 signal 的 latest outcome。每个 opened Content 注册一个
binding `subscribe(changed)` callback，并由 Framework 随每次打开释放返回的 `Disposable`；状态变化只通知 Framework 重新执行完整 `load()`。手动 flush action
调用 generation-local provider 的 `forceFlush()`，部分失败记录 bounded error type 并返回可展示的 expected failure。Content 不拥有
provider 生命周期，不增加 exporter、timer、listener 或 transport，Workbench disabled 时也不会改变 telemetry 行为。

## 环境与安全

`OtelConfig` 只属于默认 `OtelPlugin` 预设，导出值与其普通 field `configs.use()` 声明相同。Host 可用 env/file binding 选择 signal
和 Prometheus；Workbench 不提供另一份配置 authority。自定义 `@Plugin(Otel)` 不继承该 schema，可自行声明应用配置或直接装配 native providers。
默认预设通过现有 `env.ts` 显式解析已支持的 sampler、OTLP、resource 与 batch/reader `OTEL_*`，并直接构造原生 SDK 3 sampler；exporter 读取自己的标准 TLS 环境。来源都是进程环境，不由 Host `startup.env` 自动接管。SDK 3 的原生 `TracerProvider` 不读取环境变量；span limits 由自定义 provider 的 `spanLimits` 显式声明。

signal-specific OTLP 设置覆盖 generic 设置。HTTP generic endpoint 追加标准 `/v1/{signal}`，specific endpoint 视为完整 URL；gRPC
endpoint 永不追加 path。headers 先合并 generic，再由 signal-specific 覆盖。URL userinfo 被拒绝，认证必须走 headers/mTLS。

环境输入在启动时读取，对 percent encoding、header field、duplicate、entry count、UTF-8 bytes、URL、queue、batch、interval 与
timeout 做硬限制。TLS certificate/client key/client certificate 及 gRPC insecure 交由官方 Node exporter 按标准环境变量加载。

resource 是 `defaultResource()` 与显式环境 attributes 的 merge；`service.name` 依次取 `OTEL_SERVICE_NAME`、
`OTEL_RESOURCE_ATTRIBUTES`、root Context name，并共享给所有启用 signal。

## 非目标与上游阻塞

- 不提供 `measure()`、decorator、RED wrapper、固定 instruments 或 attribute registry；
- 不自动 instrument runtime、HTTP、database 或业务 Plugin；
- 不把 `ctx.logger` 悄悄桥接到 logs signal；Core 的 LogTape 输出仍由 `runtime.logtape` 配置拥有；
- 默认预设不添加 durable queue、backend routing、dashboard 或 alerting；原生 hook 可组合多个 SDK readers/processors/exporters；
- 不支持 OTLP Profiles：当前 SDK 依赖没有对应 profiles API、SDK/exporter package。

## 验证

- Pluxel Host 测试覆盖 required graph、caller cache、disabled signal、Prometheus route 与 cascade replacement；
- native providers Host 测试通过同一 abstract `Otel` 依赖选择默认/应用实现，验证原生 sampler、metric views/aggregation、
  多 span processor、log severity、scope/correlation、Workbench external 状态与 flush/shutdown 失败、启动后续失败清理；
- capturing exporters 覆盖三个 signal 的 resource/scope、原生数据、active async context、log trace correlation、幂等 shutdown 与
  partial-init cleanup；
- 本地真实 receiver 覆盖三 signal 的 HTTP protobuf、HTTP JSON 与 gRPC wire request；
- Victoria-compatible integration 覆盖 VictoriaMetrics/VictoriaLogs 的完整 signal-specific endpoint；
- build/typecheck 验证公开 peer types 和动态 exporter package boundaries。
