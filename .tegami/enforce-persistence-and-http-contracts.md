---
packages:
  '@pluxel/services':
    type: major
---

## Enforce explicit filesystem ownership and readonly writes

FS directory selectors and Host document keys reject absolute paths, traversal and ambiguous
segments instead of repairing them. Plugins use stable physical-key directories and native
promise methods; callers decide whether to sort directory entries or accept missing data.
Readonly backends reject writes and deletes without relying on requirement checks. Filesystem
roots are fixed by each Host's backend declaration.

## Forward Host cancellation without losing HTTP carrier identity

Mounted Host endpoints receive the root invocation AbortSignal combined with client cancellation.
Carrier address lookup and WebSocket upgrades continue to use the original ingress request.
