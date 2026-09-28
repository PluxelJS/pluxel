---
packages:
  '@pluxel/core': major
---

## Make effects transactions and config snapshots match their ownership contracts

Effects transactions reject overlapping siblings, require nesting through the active tx, and revoke tx views after their callback settles. Rollback releases only resources owned by that transaction; tx.dispose() no longer disposes the parent scope. Acquire checks admission before starting and releases resources that arrive after withdrawal. Callers must await child transactions and acquisition promises.

Plugin configs.use() now exposes the existing deeply frozen output as ConfigSnapshot, including readonly nested arrays and tuples. Copy configuration into owned mutable state before editing it.
