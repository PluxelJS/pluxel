---
packages:
  '@pluxel/wretch':
    type: major
---

## Migrate Wretch settings to the vNext Attachment contract

Replace the Workbench Port, resource mapping, Extension, renderer contract, and caller-forwarded RPC
with one provider-owned `WretchWorkbench.settings` Attachment. Consumers now place the Attachment and
bind their direct required `WretchPlugin` dependency; the provider creates a fresh direct Cap'n Web
settings target from the server-derived consumer node when the View opens.
