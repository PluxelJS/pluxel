---
packages:
  '@pluxel/host': major
  '@pluxel/host-vite': major
  '@pluxel/services': major
  '@pluxel/rolldown': minor
---

# Select one Plugin before configuring or invoking it

Use `sdk.plugin(descriptorOrAddress)` to create an immutable, run-scoped Plugin
reference. It captures the target once and exposes `status`, `start`, `stop`,
`restart`, and `fork`. Generated descriptors also provide typed `instance` and,
when configured, `config.get/validate/patch/reset`. Configuration methods take
only their change and operation options. The selector, reference methods, and
configuration methods can all be extracted without binding `this`.

Remove the previous root `sdk.config` and target-taking `sdk.plugins` methods.
Global discovery remains `sdk.plugins.list()`; policy, updates, and logs retain
their existing root entries. Discovered node addresses use the same selection
API with unknown configuration fields and management operations.

Selection does not create or start a node. Each operation checks the current
Host state; the same reference can reacquire a new generation after restart.
Business views remain generation-bound. Run closure revokes cached selectors,
fork selectors, and operation methods. Configuration unions retain their
association: heterogeneous unions permit reads until narrowed, known
unconfigured descriptors expose no configuration entry, and extracted methods
cannot widen the accepted schema input.

The Node and Vite descriptions advertise `plugin`, `plugin.config`, and
`plugin.instance` capabilities alongside global `plugins` discovery.

# Preserve source documentation in generated control declarations

Control declaration emit retains public JSDoc even when the author's other
outputs use `removeComments`. Descriptor and instance aliases carry the original
class documentation. Configuration input, output, and source-description types
include their validation role and original Schema documentation. Inherited and
related declarations retain their original comments; `stripInternal` continues
to follow the author's configuration. Documentation updates change material
snapshots while preserving local configuration and instance contract hashes.

Package-mode instance types retain their original published class identity;
member hover documentation still comes from that original package's types.
