# @pluxel/core

`@pluxel/core` 是 Pluxel Plugin 模型的最小稳定内核：提供 Context projection/DI、opaque definition/node slot、结构化
address、required/optional graph、generation lifecycle、effects、Plugin/PluginPart composite object config 和具名事件 channel。

Core 源码复用公开的 `@pluxel/context` host kernel；构建时通过 tsdown 完整内联其 JavaScript 与 declarations，因此发布的
`@pluxel/core` 没有 `@pluxel/context` production dependency，Core 消费者也不需要额外安装它。只有需要直接创建 standalone
Context host 的应用才依赖 `@pluxel/context`。

Plugin definition facts由 Pluxel Vite/Rolldown semantic pass 生成。required constructor value import 和
`definePluginRef<T>()` type provenance 都会 lower 成 slot edge；Core 不使用 class/display name、constructor identity
或通用 decorator metadata 作为 graph facts。optional ref 只观察 host catalog，不负责 package import、安装或 retry。

本包不包含 HTTP/control plane、persistence、workspace scan、包安装、Vite 或 HMR；这些分别位于 runtime 与 route packages。

文档入口：

- [`../../engineering/CORE.md`](../../engineering/CORE.md)
- [`../../engineering/PLUGIN_SYSTEM.md`](../../engineering/PLUGIN_SYSTEM.md)
- [`../../engineering/CONFIG.md`](../../engineering/CONFIG.md)
- [`../../engineering/LOGGING.md`](../../engineering/LOGGING.md)
- [`../../docs/reference/context-hosts.md`](../../docs/reference/context-hosts.md)

公开入口：

- `@pluxel/core`：Plugin Context、Plugin 作者面、standalone Context host re-export，以及 address/lifecycle 等只读公共契约；
- `@pluxel/core/services`：effects、config helpers、module-augmented `EventsService` 与 `EvtChannel` 等基础服务；
- `@pluxel/core/logger`：Context logger facade 与 structured Plugin category identity；
- `@pluxel/core/test`：明确的 core 测试边界；测试 Plugin 仍应使用 semantic lowering。
