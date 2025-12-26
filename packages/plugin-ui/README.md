# @pluxel/plugin-ui

This package defines the **stable UI extension protocol** between:

- the **host** (frontend that renders extensions), and
- **plugins** (server-side code that registers UI contributions, optionally without shipping a UI bundle).

## Core concepts

- **Extension point**: a named mount location (e.g. `plugin:tabs`, `plugin:info`, `global:statusBar`).
- **UI module**: a plugin-provided browser bundle registered via `ext.ui.register({ entryPath })`.
- **Builtins**: JSON-serializable, host-rendered UI blocks registered via `ext.ui.*` helpers (no browser bundle).

## Recommended pragmatic surface

If you want low learning-cost + low coupling to a specific frontend, prefer:

- **Read-only**: `infoCard`.
- **Interaction**: `rpcAutoForm` (valibot-form AutoForm + RPC submit).

For richer UI (charts, complex layout, form logic), use a full UI module.

## Builtins conventions

- **JSON only**: builtin defs must be JSON-serializable (safe to ship via manifest; frontend-agnostic).
- **SSE references**: use `{ kind: 'sse', event?, path?, fallback? }` to bind values to live plugin state.
- **Private schemas**: config schema keys starting with `_` are treated as internal and are hidden from the Config UI,
  but can still be referenced by `rpcAutoForm.schemaKey`.
- **Mixed tabs**: `plugin:tabs` meta supports `meta.tab: { id, label, icon? }` so multiple extensions can render into
  the same host tab (mixed layouts).

## Where to look

- Protocol types: `packages/plugin-ui/src/types.ts`
- Host renderers (builtins): `packages/components/src/extension/builtin`
- Server registration helpers: `packages/hmr/src/services/plugin-interaction/ExtensionService.ts`
- Demo plugin (builtins-only): `packages/hmr/tests/ui-demos/PluginBuiltinShowcase.ts`
