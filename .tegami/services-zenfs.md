---
packages:
  '@pluxel/core': major
  '@pluxel/services': major
  '@pluxel/host': major
  '@pluxel/create': patch
  '@pluxel/plugin-wretch': major
  '@pluxel/plugin-fonts': major
---

## Use Core-owned ZenFS directories for runtime data

Every Plugin and Part obtains its stable owner directory through the fixed
`ctx.fs()` capability. Compose native ZenFS mounts once through `config.storage`, using built-in or
external backends, nested configurations and borrowed FileSystem instances.
Backend declarations, native configuration types and `writeFileAtomic` are
exported from `@pluxel/core/fs` and `/fs/browser`. Services no longer exports FS
factories or tokens. Core ships the patched ZenFS runtime, declarations and notices.

File operations preserve native errno and atomic temporary-file/rename commits.
Host config/state documents use Core TinyBase by default, while explicit document
factories still borrow their backend. FS closes after TinyBase and domain flushes. Native backend configurations are
owned and released, while direct FileSystems are borrowed through isolated
views. `durableMounts` explicitly declares persistence per mount; readonly
requirements use actual backend attributes. Passthrough prefixes must be created
by the application, and module-global ZenFS policy options are excluded from
per-Core configuration.
Vault, Cache, Fonts and Wretch retain their resource-specific data contracts.
Source discovery, package installation and native artifacts retain their own IO.

Ordinary stop, restart and fork removal preserve files. Existing deployments must
explicitly copy known old data; startup does not read old paths or migrate data.
