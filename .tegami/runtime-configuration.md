---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/host':
    type: major
  '@pluxel/host-vite':
    type: major
  '@pluxel/services':
    type: major
  '@pluxel/test':
    type: major
  '@pluxel/workbench':
    type: major
  '@pluxel/rolldown':
    type: major
  '@pluxel/create':
    type: major
---

# Unify runtime configuration and preserve raw saved input

Host applications, standalone Hosts and test Hosts now use top-level `name` and one `runtime` object containing `zenfs`, `logtape`, `tinybase`, `state` and `configRecords`. Core standalone constructors retain `name`. LogTape accepts native configuration or a root factory directly, with `{ input, options }` for framework policy; `logtape()` and `zenfs()` remain optional presets. Reference lowered Plugin nodes with `MyPlugin.nodeAddress()` or `MyPlugin.nodeAddress('fork')`.

Configuration uses `configRecords.records`; state declares its lists directly and stores fork node addresses. By default declarations initialize only missing documents. Explicit `override: true` affects the current runtime without overwriting saved data and makes controlled paths or state lists read-only to management. Saving preserves raw input, excluding schema defaults/transforms and environment overlays. Reset explicitly restores declared input; an empty key list does nothing. Inferred provider defaults remain runtime decisions.

Host configuration v4 and state v6 are ordinary FS documents under `services/host/<namespace>/<key>`. Previous document versions and TinyBase Host envelopes require explicit conversion; no compatibility reader or startup migration is retained. Configuration observes external file changes; state is loaded only at startup. FS retains atomic writes, bounded document size, subscription cancellation and close-time draining. TinyBase continues to own Plugin Stores.

Environment resolution requires explicit input. Native listeners receive hostname, port and publicOrigin from their launcher and do not read process environment. Service presets consume verified deployment facts. Dev-console inspection exposes declared, saved and effective configuration and state separately.
