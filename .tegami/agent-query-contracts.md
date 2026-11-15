---
packages:
  '@pluxel/host': major
  '@pluxel/host-vite': minor
  '@pluxel/services': major
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

# Separate definition inspection from runtime node operations

Use `sdk.inspect(Plugin.definitionAddress(), options)` for source queries, including abstract dependency tokens. Discovered nodes use `sdk.inspect(node.address.definition)`. The node handle no longer provides `inspect()`; `sdk.plugin(Plugin.nodeAddress())` continues to own runtime operations. Source lookup stays valid across constructor replacement and catalog removal and explicitly reports current disk content with runtime matching unverified.

Discovery reuses one identity inventory per Host and filter while its committed inputs remain unchanged. It continues to project current status and diagnostics for every bounded page. Membership, owner, filter or revision changes invalidate the corresponding cursor. Templates, workspace instructions and Vite capabilities follow the same inspection entry.

# Reject incompatible Management clients before writes

Management protocol major is now 13. Auto-start batches return their original `managedRevision` for undo; major 12 parsers reject this field, so clients and servers must upgrade together and validate `describe()` before performing management operations.
