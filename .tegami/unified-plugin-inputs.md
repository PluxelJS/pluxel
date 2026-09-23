---
packages:
  '@pluxel/core': major
  '@pluxel/host': major
  '@pluxel/host-dev': major
  '@pluxel/services': major
  '@pluxel/rolldown': major
  '@pluxel/workbench': major
  '@pluxel/auth': major
  '@pluxel/vault-admin': patch
---

## Bind deployment inputs and preserve editable configuration layers

Application factories declare `envBindings` and `fileBindings` with `envBinding` and
`fileBinding`, importing the configuration and Vault root schemas explicitly. Binding helpers
check schema input keys; Plugins keep `configs.use(schema)` without static schema fields.
Host verifies that a config binding references the same schema as the Plugin's lowered declaration.
Static builds derive `.env.example` from the explicit schemas without evaluating factories or
reading deployment values. Published declarations provide field completion without compiler plugins.
Config merges base, saved values, and environment overrides recursively, replacing arrays.
Only management edits persist. Environment-controlled paths reject writes, and management
responses expose value-free source metadata. The previous environment bootstrap helper and
implicit `PLUXEL_CONFIG` snapshot are removed.

## Use structured Vault snapshots with durable writes and deployment records

Vault KV reads return immutable snapshots with revision, source, and writability. Writes support
expected revisions, batches publish only after durable commit, and owner-scoped subscriptions
observe committed changes. Environment/file records are whole-record read-only overlays;
bindings-only installations need neither Persistence nor disk keys. Encrypted Vault takes an
explicit deployment identity. Named namespaces are owner-local; legacy global namespaces require
explicit owner migration mappings. Legacy documents migrate to collision-checked KV keys.
Vault root schemas validate record keys and complete records as an application startup contract;
Plugin hot replacement does not change that contract or repeat input transforms.

Official authentication and storage plugins export their deployment schemas, consume structured
credential records, and observe updates. The showcase and local applications migrate their
credential and account workflows.

Vault administration displays KV and blob counts for the unified storage model.
