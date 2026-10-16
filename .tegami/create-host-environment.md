---
packages:
  '@pluxel/create': patch
---

# Use the shared Host environment parser in generated applications

Generated applications resolve data paths and the Workbench switch through `resolveHostEnv(startup.env)`, keeping normalization and invalid-value errors consistent with the Host environment contract.
