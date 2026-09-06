---
packages:
  '@pluxel/runtime':
    type: minor
  '@pluxel/runtime-static':
    type: minor
  '@pluxel/runtime-dynamic':
    type: minor
  '@pluxel/cli':
    type: minor
---

## Operate the running Vite host from TypeScript development scripts

Opt in with `devConsole: true` on the static or dynamic Vite integration. `pluxel dev`
discovers local instances and submits scripts to the existing Vite module runner, with bounded
JSON results, request deduplication, cooperative cancellation and result recovery. Discovery is
project-scoped; ambiguous instances require an explicit selector. CLI diagnostics and receipts
include the selected root and instance when known so agents can recover against the same host.
Unknown dev options are rejected before connecting, and command results use a single JSON frame.

The `@pluxel/runtime/dev` script interface exposes current Plugin discovery and typed instance
access, production lifecycle reports, configuration inspection/validation/editing, typed local
Workbench RPC sessions, commands, HTTP and cursor-based logs. Each run owns its temporary
resources while application state remains in the running host. Default development logging
captures a bounded store without requiring Workbench; custom and silent logging keep precedence.

Source preparation waits for real Vite watcher admission and the existing route update queues,
preserving module identity without synthesizing duplicate Plugin updates. The execution
service currently requires Unix local socket permissions; it is not exposed through the Vite HTTP listener.
