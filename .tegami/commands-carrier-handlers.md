---
packages:
  '@pluxel/commands': minor
  '@pluxel/services': major
---

## Keep carrier handling inside publication ownership

Command mounts accept `{ install, handle? }` instead of an installer callback. The optional
handler receives the captured Command, untrusted input, and carrier context; authorization,
context projection, execution, and response presentation settle within the provider and
publisher invocations. A custom handler can project its own output type and construct a
command-specific context. Direct bindings still execute the selected Command unchanged.

Mounted endpoints carry an explicit marker and cannot be re-mounted as direct definitions.
The new `snapshotCommand()` captures and validates the descriptor and execute function without
creating a temporary registry, preserving the receiver and existing publication withdrawal.
