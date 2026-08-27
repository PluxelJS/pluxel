---
packages:
  '@pluxel/core':
    type: major
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/wretch':
    type: major
---

## Make Plugin identity stable and readable

Replace snapshot/instance identities with strict definition/node addresses and registry-interned slots.
Canonical package roots or named source spaces now survive filesystem layout changes, while native
realpath containment rejects symlink escapes and machine-specific absolute paths.

Expose reversible, human-readable Plugin references and versioned routes across diagnostics, logs,
Workbench and management projections. Business Elysia paths do not derive a default Plugin HTTP namespace.
Forks share definition-scoped source, schema, artifacts
and HMR replacement while retaining node-scoped lifecycle, config and resource ownership.

Use a clean persistence break across RuntimeState, Config, logger policy, Workbench preferences and
browser state, database owners, Vault namespaces, Wretch settings, caches and rate limits. Each reader
accepts only its current schema; no automatic migration, dual-read, redirect or display-name fallback
remains. Private namespaces use collision-resistant canonical address hashes without exposing digests
as public Plugin IDs.
