---
packages:
  '@pluxel/plugin-fonts': patch
---

# Keep native font consumers independent of React

Load Workbench DTO validation when a Workbench RPC snapshot is requested, preserving the existing static publication and Plugin identity. Keep the public server font snapshot declarations separate from Workbench RPC declarations so native consumers can check types without loading UI or RPC types.
