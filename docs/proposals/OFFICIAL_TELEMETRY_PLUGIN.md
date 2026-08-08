# Pluxel 官方 Telemetry 剩余边界

> 状态：部分完成。metrics、traces、logs 的原生作者 API 与 OTLP transports 已在 `@pluxel/otel` 实现；当前 contract 以
> [`../../plugins/otel/DESIGN.md`](../../plugins/otel/DESIGN.md) 为准。本文只保留尚未实现或仍需证据的边界。

## 已落地

- caller-scoped 原生 OTel `Meter`、`Tracer`、`Logger`；
- local provider 与 generation-owned lifecycle，不注册 global provider；
- metrics、traces、logs 的 OTLP gRPC、HTTP protobuf、HTTP JSON push；
- metrics 的独立 Prometheus pull；
- AsyncLocalStorage active context、W3C tracecontext/baggage、log trace correlation；
- signal-specific configuration、bounded batching、diagnostics、partial-init cleanup 和幂等 shutdown。

## Profiles：上游阻塞

OTLP Profiles 当前仍位于 `opentelemetry-proto/profiles/v1development`。本仓库采用的 OTel JS 2.10/0.221 没有 profiles API、
SDK、processor 或 OTLP exporter npm package，因此无法给下游一个原生、可互操作的 contract。

解除阻塞至少需要：

1. OTel Profiles 数据模型与 OTLP schema 进入可依赖版本；
2. OTel JS 发布 API、SDK、processor/exporter，并定义 resource/scope/context 语义；
3. 有真实 producer、backend、sampling/drop、内存与 shutdown 验收。

在此之前不导出 `profiler` getter、不手写 proto client，也不返回 no-op facade。

## RuntimeLogging bridge：保持分离

`ctx.logger` 属于 launcher-owned `RuntimeLogging`：进程只有一个 active root，sink 在 boot 时确定。`OtelPlugin` 是可选且可
replacement 的 graph member，不能在 init 时偷偷重配该 root 或动态追加永久 sink。

当前下游需要 logs signal 时显式调用 `otel.logger.emit()`。未来只有在 RuntimeLogging 本身提供 lifecycle-safe、多 owner、可撤销的 sink
extension point，并有明确 loop prevention、redaction、backpressure 和故障隔离 contract 后，才考虑单独的 opt-in bridge。

## Auto-instrumentation

本包安装 context/propagator，但不自动 patch HTTP、database 或第三方库。自动 instrumentation 会改变整个进程、加载顺序敏感且通常
不可撤销，应由 launcher 在进程启动边界显式装配。未来若提供 preset，必须与 local provider authority、多 Host 和 HMR/replacement
模型兼容，不能由普通 Plugin 在 init 中隐式安装。

## 产品边界

不属于服务器 OTel runtime：

- Workbench pageview、Web Vitals 和浏览器 analytics；
- license/customer heartbeat 和商业数据上报；
- dashboard、alerting、Collector SaaS、durable queue、remote control 与多 backend policy；
- 每个 producer 的 instrument/span/event 数据字典、attribute cardinality 与隐私策略。
