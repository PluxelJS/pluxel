---
'@pluxel/runtime': major
'@pluxel/runtime-dynamic': major
---

Make the dynamic route a mutable file-source runtime. Add explicit file and directory sources, route
their add/change/remove lifecycle through the existing graph transaction and HMR pipeline, and keep
OXC resolution and module execution in the dynamic core.

Remove package installation, package state, package-manager RPC/types, and the built-in Workbench
package page from runtime packages. Package acquisition, commands, owner-bound RPC, and UI now live
in the optional official pnpm NAPI package-manager plugin, which publishes ordinary ESM source
entries for the dynamic route.

Keep the root dynamic export limited to configuration, the direct launcher, and source/builtin
types. Directory sources require explicit bounded globs; imported dependencies, file addition, and
transactional file removal share the HMR graph lifecycle. The official package producer rejects
non-registry selectors before invoking pnpm and requires an exact build allow-list when scripts are
enabled.
