---
packages:
  '@pluxel/services': major
---

## Return Command Result from runtime services

Root catalog and carrier mount execution now return `Result<T, CommandFailure>`.
Owner admission, withdrawal, and execution faults have explicit failure branches, while
completed command receipts remain intact. Management commands define recoverable missing
plugins as `REJECTED` and retain lifecycle failures as `DEPENDENCY`.
Unreadable trusted command contexts settle as `INTERNAL` with the original local cause.
