---
packages:
  '@pluxel/services': major
  '@pluxel/host': major
  '@pluxel/create': patch
  '@pluxel/plugin-wretch': major
  '@pluxel/plugin-fonts': major
---

## Use Host-owned ZenFS directories for file storage

Replace `@pluxel/services/persistence` with `@pluxel/services/fs`. Declare
`fs({ backend: InMemory })`, Node `Passthrough`, or browser `IndexedDB` explicitly.
Plugins obtain their stable owner directory with `ctx.require(PluginFs)()`; root
services use `root.require(Fs)`. File operations preserve native errno values.
`writeFileAtomic` commits a complete file through a closed temporary file and
same-directory rename. Fixed ZenFS implementations and notices ship inside the
Services artifact, including for independent installations.

Host config/state storage and Logging policy stores now accept synchronous root
factories. `HostDocumentStorage.put(key, text)` always requires an atomic commit;
the optional atomic flag has been removed. Storage remains borrowed and optional.

Vault, Management, Cache, Fonts and Wretch use their fixed service or provider
directories. Ordinary stop, restart and fork removal preserve files. Existing
deployments must explicitly copy known data to the new layout; startup does not
read old paths or migrate data. Starter applications now select Passthrough under
their data root's `fs` directory.
