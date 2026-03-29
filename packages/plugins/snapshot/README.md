# @pluxel/snapshot

> Status: internal/private builtin plugin (workspace-only). Not part of the 5 published packages.

Builtin snapshot builder plugin.

What it does:
- Generates `.pluxel/snapshot/snapshot.config.ts` with the running plugin constructors + raw configs.
- Generates `.pluxel/snapshot/snapshot.main.ts` as a **core-only runtime entry** (no HMR/UI).
- Builds a runnable `dist/` from the snapshot main entry (tsdown bundle + nf3 trace/copy).

Notes:
- The generated runtime is a **core-only runtime entry**: it does not start HMR and does not consume authoring-time UI source declarations such as `ui(...).bind(ctx)`.
- It is meant for runnable snapshot execution, not for serving the normal plugin frontend surface.
- Snapshot/build is exposed via RPC + host UI actions in the header.

最容易误解的一点是：

- snapshot 产物不是标准插件 UI remote
- 它不会替代 `ctx.ext.ui.remote.packaged()` 这条正常前端链路
- 它解决的是“冻结一份可运行 runtime 快照”，不是“构建插件前端”
