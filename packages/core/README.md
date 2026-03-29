# @pluxel/core

`@pluxel/core` 是 Pluxel 的最小稳定内核：提供 `Context`/DI、插件生命周期、以及基础 services 合约。

它不包含 runtime kernel 的“宿主能力”（HTTP/control-plane、workspace 扫描、包安装、HMR 等），这些都在：

- `@pluxel/runtime`（kernel services + 稳定协议/路由）
- `@pluxel/hmr`（dev-time：Vite + watch + runner + HMR）

文档入口：

- `docs/architecture/system.md`
- `docs/governance/agent-rules.md`

对外导出（package exports）：

- `@pluxel/core`：Context + 插件/特性基类
- `@pluxel/core/services`：基础 services（events/effects/config 等；不包含宿主能力）
- `@pluxel/core/logger`：日志基础设施
