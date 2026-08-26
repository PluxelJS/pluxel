---
packages:
  '@pluxel/commands':
    type: major
---

## Streamline the command kernel

Use one validated throwing `execute()` path, make the registry the sole owner of revisioned catalog
snapshots and subscriptions, and return typed live registrations that follow schema-compatible
replacements while failing closed after withdrawal or incompatible replacement.

Keep argv as an explicit binding and resolution layer, and remove the built-in catalog argv,
provider-neutral tool projection, result wrapper, registry lookup, router dispatch, and router help
APIs. Dynamic registry calls use the single `execute()` path; statically typed consumers retain the
handle returned by `register()`.
Dynamic argv resolution now returns `unknown` by default; homogeneous carriers can declare one
shared output type and have it enforced for every binding.
