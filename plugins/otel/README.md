# `@pluxel/plugin-otel`

原生 OpenTelemetry Meter / Tracer / Logger，支持 OTLP 与 Prometheus。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

业务插件通过 constructor 依赖抽象 `Otel`，直接使用原生 Meter / Tracer / Logger。
宿主 catalog 选择 `OtelPlugin` 默认 OTLP/Prometheus 预设，或应用的 `@Plugin(Otel)` 实现。
自定义实现的 `createProviders()` 返回原生 providers，由 generation 统一 flush 和关闭；SDK 参数无需经过另一套 schema。

- [用法、配置与验证](../../docs/plugins/otel.md)
- [维护约束](DESIGN.md)
