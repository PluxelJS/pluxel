---
'@pluxel/core': major
'@pluxel/runtime': major
'@pluxel/runtime-static': major
'@pluxel/runtime-dynamic': major
---

Replace the legacy logger presets, ensure helper, module-level policy, and global runtime stores with
one launcher-owned RuntimeLogging root. Plugin identity now lives in categories, per-plugin levels
remain dynamically adjustable through an O(1) policy lookup, and launchers own policy persistence,
sinks, stores, installation, and shutdown.
