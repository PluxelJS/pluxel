---
'@pluxel/core': minor
'@pluxel/runtime': minor
'@pluxel/runtime-dynamic': minor
'@pluxel/rolldown': minor
'@pluxel/cli': minor
---

Add system-owned package-optional plugin references with post-commit resolution, canonical-ID graph
ownership, external optional peers for plugin packages, and static/Vite bundle-or-absent lowering.

Replace import-form dependency guessing with semantic plugin package metadata generation using
`pluxel.pluginPackages`, multi-format-stable peer synchronization, optional peer metadata, and
cleanup of stale generated or legacy dependency fields. Detected required and optional provider
packages remain external from the first plugin-package build, including when their version source is
only a development dependency.

Align generated plugin and application templates with the author guides: keep application names free
of plugin prefixes, normalize prefixed plugin inputs, generate named `*Plugin` constructors and
disabled-Workbench lifecycle tests, bundle the canonical user docs into both templates, and verify
standalone package contents in the release smoke test.
