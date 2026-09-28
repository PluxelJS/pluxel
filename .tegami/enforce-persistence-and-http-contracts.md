---
packages:
  '@pluxel/services': major
---

## Enforce persistence paths, readonly writes and consistent directory queries

Persistence rejects absolute paths, traversal and ambiguous path segments instead of repairing them.
Namespaces retain literal names including `@pluxel`; any existing files in the former sanitized
`_pluxel` namespace require a one-time move before using the new backend. No fallback reader is installed.
Memory and filesystem backends list sorted immediate children and stat directories. Readonly workspace
and custom service backends reject writes and deletes even without preflight. Filesystem roots are fixed
when the backend is created.

## Forward Host cancellation without losing HTTP carrier identity

Mounted Host endpoints receive the root invocation AbortSignal combined with client cancellation.
Carrier address lookup and WebSocket upgrades continue to use the original ingress request.
