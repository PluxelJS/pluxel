---
packages:
  '@pluxel/core': major
  '@pluxel/host': major
  '@pluxel/services': major
  '@pluxel/workbench': major
---

# Keep Plugin identities and resource ownership at their source

Use `Plugin.definitionAddress()` instead of the public `pluginDefinitionAddressOf()` helper. `Plugin.nodeAddress()` returns a default-node address, while `Plugin.nodeAddress(forkId)` returns a fork address. Both resolve lowered identities without creating or starting a node.

Host fork operations consume a complete fork address, and `state.forks` accepts only fork addresses. Management protocol major 8 carries the same target instead of splitting it into a base and fork ID. Omitting `autoStart` preserves existing fork policy.

Production Hosts support `await using` through `Symbol.asyncDispose`, sharing the existing idempotent `close()` operation, draining and error propagation.

Workbench Content bindings return `subscribe(changed)` with a standard `Disposable`. Each opened Content owns its subscription, observes before its first load, and releases on close. A failed initial load retains the subscription for retry. The old `dataChanged` factory callback is removed, and workspace consumers use the new binding contract.

Custom Otel providers implement `workbenchOperations()` without a context parameter; their returned Content binding owns its subscription through the same contract.
