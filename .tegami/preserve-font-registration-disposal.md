---
packages:
  '@pluxel/fonts':
    type: patch
---

## Preserve idempotent font registration disposal

Keep `FontRegistration.dispose()` harmless after its consumer generation stops by binding cleanup
to provider-owned registry state instead of retaining a generation-bound Plugin caller receiver.
