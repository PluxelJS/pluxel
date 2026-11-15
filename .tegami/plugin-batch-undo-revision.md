---
packages:
  '@pluxel/services': patch
  '@pluxel/workbench': patch
---

# Bind bulk auto-start undo to its original policy revision

Admitted Management auto-start batches return `managedRevision` captured before releasing their exclusive policy boundary. This token preserves the batch's own managed-policy version while keeping each result's persistence, lifecycle and partial-failure outcome intact.

Workbench uses that returned token for undo instead of a later catalog refresh. If another client changes the policy after the original batch, undo reports `revision_conflict` and preserves the later write. Lifecycle batches and requests rejected before admission do not provide the token.

Malformed auto-start mutation options return a complete `invalid_input` / `state: unchanged` result that remains valid across the Management wire boundary.
