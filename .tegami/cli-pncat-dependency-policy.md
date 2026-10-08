---
packages:
  '@pluxel/cli': minor
---

# Synchronize workspace dependency catalogs through bundled pncat

Add `pluxel workspace sync` and its read-only `--check` mode. Git and npm CLIs use the same core catalog policy; workspace/source doctors report drift, and source installation synchronizes existing catalogs before installing. Bundle pncat so consumers need no separate pncat installation, reject unmigrated declarations and shared peer conflicts without rewriting package manifests, preserve peer compatibility and dependency exceptions, and invalidate CLI builds when the policy or bundled pncat changes.
