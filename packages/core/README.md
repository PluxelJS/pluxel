# @pluxel/core

`@pluxel/core` 是 Pluxel 的最小稳定内核：提供 `Context`/DI、插件生命周期、opaque `OptionalPluginRef` 声明、
instance watcher，以及基础 services 合约。optional package import 和 retry 仍由 runtime/route 承担。

它不包含 runtime kernel 的“宿主能力”（HTTP/control-plane、workspace 扫描、包安装、loader HMR 等），这些都在：

- `@pluxel/runtime`（kernel services + 稳定协议/路由）
- `@pluxel/runtime-dynamic/vite`（dynamic route 安装到 host-owned Vite server）
- `@pluxel/runtime-dynamic/hmr`（CLI/test-facing workspace diagnose 和 loader HMR internals）

文档入口：

- `docs/CORE.md`
- `docs/CONFIG.md`
- `docs/LOGGING.md`
- `docs/proposals/README.md`

对外导出（package exports）：

- `@pluxel/core`：Context + 插件/特性基类
- `@pluxel/core/services`：基础 services（events/effects/config 等；不包含宿主能力）
- `@pluxel/core/logger`：Context logger facade 与 category identity
