# @pluxel/core

`@pluxel/core` 是 Pluxel 的最小稳定内核：提供 Context/DI、opaque definition/node slot、结构化 address、required/optional
graph、generation lifecycle、effects、single-object config 和具名事件 channel。

Plugin definition facts由 Pluxel Vite/Rolldown semantic pass 生成。required constructor value import 和
`definePluginRef<T>()` type provenance 都会 lower 成 slot edge；Core 不使用 class/display name、constructor identity
或通用 decorator metadata 作为 graph facts。optional ref 只观察 host catalog，不负责 package import、安装或 retry。

本包不包含 HTTP/control plane、persistence、workspace scan、包安装、Vite 或 HMR；这些分别位于 runtime 与 route packages。

文档入口：

- [`../../docs/CORE.md`](../../docs/CORE.md)
- [`../../docs/PLUGIN_SYSTEM.md`](../../docs/PLUGIN_SYSTEM.md)
- [`../../docs/CONFIG.md`](../../docs/CONFIG.md)
- [`../../docs/LOGGING.md`](../../docs/LOGGING.md)

公开入口：

- `@pluxel/core`：Context、Plugin 作者面、identity snapshots 与 slot-aware registry；
- `@pluxel/core/services`：effects、config helpers 与 `EvtChannel` 等基础服务；
- `@pluxel/core/logger`：Context logger facade 与 structured Plugin category identity；
- `@pluxel/core/test`：明确的 core 测试边界；测试 Plugin 仍应使用 semantic lowering。
