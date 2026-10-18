---
packages:
  '@pluxel/rolldown':
    type: patch
  '@pluxel/cli':
    type: patch
  '@pluxel/host-vite':
    type: patch
---

## Reject incomplete workspace and package discovery

Workspace membership now comes from `pnpm-workspace.yaml`. Malformed selected manifests, invalid patterns, and scan IO failures stop discovery instead of silently dropping candidates. Host module classification stops at a broken package manifest, and OXC initialization and thrown resolution failures retain their causes.
