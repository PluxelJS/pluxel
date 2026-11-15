---
packages:
  '@pluxel/host': major
  '@pluxel/host-vite': minor
  '@pluxel/services': major
  '@pluxel/cli': patch
  '@pluxel/create': patch
---

# Separate definition inspection from runtime node operations

Source querying uses `inspectPlugin(definition, options)` from `@pluxel/agent-sdk/source`, including abstract dependency tokens. Discovered nodes pass `node.address.definition`; the Host SDK owns runtime node operations. Source lookup reports current disk content with runtime matching unverified.
Discovery reuses one identity inventory per Host and filter while its committed inputs remain unchanged. It continues to project current status and diagnostics for every bounded page. Membership, owner, filter or revision changes invalidate the corresponding cursor. Templates and workspace instructions follow the same source entry.

# Reject incompatible Management clients before writes

Management protocol major is now 13. Auto-start batches return their original `managedRevision` for undo; major 12 parsers reject this field, so clients and servers must upgrade together and validate `describe()` before performing management operations.
