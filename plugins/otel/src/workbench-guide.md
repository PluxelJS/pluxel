# OpenTelemetry 运维说明

本页说明运行中的 OpenTelemetry Plugin 如何输出 telemetry。输出选择与 Prometheus 路径仍在 Config 页面保存；修改配置会由 Runtime 按正常 Plugin lifecycle 应用。

## 当前输出状态

::slot[status]

::slot[flush]

## OTLP endpoint

- Generic HTTP endpoint 会为启用的 signal 分别追加 `/v1/metrics`、`/v1/traces` 与 `/v1/logs`。
- Signal-specific endpoint 必须填写 Collector 或后端要求的完整地址。
- gRPC endpoint 不追加 HTTP path，通常使用端口 `4317`；OTLP HTTP 通常使用端口 `4318`。
- Header、证书与 client key 应由部署环境提供，不要写入普通 Plugin config、日志或 telemetry attribute。

## 排查导出失败

后端暂时不可达不会阻塞业务 Plugin。当前 Plugin 会按 signal 对重复错误限频记录，并在恢复后记录 recovery；请先查看本页下方的 Plugin 日志，再检查 endpoint、协议、TLS、租户 header 与 Collector ingest 配置。

无效的启动配置会直接使 Plugin 启动失败。若 Plugin 当前未运行，请回到 Config 页面修正配置，而不是依赖本页执行恢复操作。

## Prometheus

Prometheus pull 只导出 metrics。启用后使用 Config 中的固定 Plugin route；它与 OTLP metrics push 可以同时工作，也不会创建第二个 HTTP listener。

Workbench Content 不显示 credential、完整 header 或未保存的 Config draft。
