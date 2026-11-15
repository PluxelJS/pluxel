---
packages:
  '@pluxel/agent-sdk': minor
  '@pluxel/cli': patch
---

## Agent SDK owns official terminal command adapters

Agent SDK now provides the official CLI's internal lazy command entry for `script run/result/cancel/sync` and `dev instances/run/hmr/sync`, including command help, file handling, progress, JSON errors and exit status. Direct Node callers continue to use `/source`, `/host` and `/client` without loading terminal adapters.

`@pluxel/cli` retains the sole `pluxel` executable, command mounting, development service startup and service-only status. Remove its direct Host dependency and limit SDK internal client exports to the existing service integration and console protocol tests. Existing command names, receipts and execution behavior are preserved.
