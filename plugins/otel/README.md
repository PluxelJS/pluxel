# `@pluxel/otel`

原生 OpenTelemetry Meter / Tracer / Logger，支持 OTLP 与 Prometheus。

本包为 workspace 内部预览，不是仓库外项目的安装入口。

宿主 catalog 需要 OtelPlugin；业务插件通过 constructor 注入直接使用的能力。

- [用法、配置与验证](../../docs/plugins/otel.md)
- [维护约束](DESIGN.md)
