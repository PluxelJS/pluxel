---
packages:
  '@pluxel/management': major
  '@pluxel/workbench': patch
---

## Consolidate Management integration entries

Remove unused and duplicate implementation-file exports, including the redundant `/endpoint` alias; use the package root for carrier endpoints. Official integrations now share `/internal` for portable presentation, `/internal/http` for HTTP assembly and `/internal/test` for cross-package white-box tests. Existing browser client, protocol, session and React imports use their public entries. Management-owned regression tests live with Management and no longer require published private implementation paths.

Management imports Cap’n Web, Logging wire types and Host fork/report operations directly from their owning packages, removing transparent forwarding modules and unused helpers. Config usecases use the existing wire result types directly. Workbench Shell asset constants move out of Management’s private presentation contract.
