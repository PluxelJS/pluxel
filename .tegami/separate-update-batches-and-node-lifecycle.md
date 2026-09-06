---
packages:
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-static':
    type: patch
  '@pluxel/runtime-dynamic':
    type: patch
---

## Separate update transactions from node lifecycle history

Management protocol 5 replaces the flat recent-update record with `batch` transaction facts and nullable,
node-specific `lifecycle` facts. Static and dynamic routes share a bounded tracker that attributes failures
and blocked dependencies to exact nodes, including forks, without marking healthy peers as failed.

Workbench separates current state, historical node errors and the containing update batch. Application
replacement, compensation, pre-commit retention and post-commit failures keep their distinct meanings.
Management clients and servers must be upgraded together for the new protocol shape.

Document existing recovery guarantees and add regression coverage for consecutive rejected edits,
automatic recovery after configuration or startup failures, required consumers with unchanged source,
explicit stop intent, and real Vite HTTP/WebSocket retention. Post-commit startup failure still does not
promise uninterrupted fallback to an old generation.
