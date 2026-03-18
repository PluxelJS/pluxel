# @pluxel/snapshot

> Status: internal/private builtin plugin (workspace-only). Not part of the 4 published packages.

Builtin snapshot builder plugin.

What it does:
- Generates `.pluxel/snapshot/snapshot.config.ts` with the running plugin constructors + raw configs.
- Generates `.pluxel/snapshot/snapshot.main.ts` as a **core-only runtime entry** (no HMR/UI).
- Builds a runnable `dist/` from the snapshot main entry (tsdown bundle + nf3 trace/copy).

Notes:
- The generated runtime **does not start HMR or UI**; plugins that rely on `ctx.ui` are not supported.
- Snapshot/build is exposed via RPC + UI extension buttons in the header.
