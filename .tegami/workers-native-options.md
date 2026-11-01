---
packages:
  '@pluxel/services':
    type: minor
---

## Preserve native Node worker startup options

`workers({ worker })` accepts native `WorkerOptions` for environment, arguments,
thread names, startup data, resource limits and file descriptor tracking. Options remain code
configuration, including the native `SHARE_ENV` symbol, and are passed to every
thread without changing shared scheduling or result/execution settlement.

Pluxel retains ownership of the entry, per-task messages and transfer, and
inherited stdio. The corresponding `eval`, `transferList`, `stdin`,
`stdout` and `stderr` options are excluded and explicitly rejected at runtime.
