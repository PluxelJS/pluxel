---
packages:
  '@pluxel/cli': patch
  '@pluxel/rolldown': patch
  '@pluxel/host': patch
---

# Keep build configuration in project files

Plugin builds discover the project's `tsdown.config.*` and write generated metadata under `package.json`'s `pluxel` field. Remove the undocumented `PLUXEL_TSDOWN_CONFIG` and `PLUXEL_MANIFEST_FIELD` overrides and the custom metadata-field option. Remove the unused `PLUXEL_HMR_ATTRIBUTION` environment declaration.
