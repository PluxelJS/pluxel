---
packages:
  '@pluxel/runtime':
    type: major
---

## Streamline the runtime command catalog

Make command execution a single throwing path and return typed executable registrations from
`ctx.commands.register()`. Delegate catalog snapshots and subscriptions to the shared command registry,
remove duplicate runtime lookup/result APIs, and keep owner invocation close/drain in the Core generation
lifecycle. Agent-bound catalogs now expose only live filtered discovery and call-time-enforced execution.
