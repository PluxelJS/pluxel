---
packages:
  '@pluxel/services': major
  '@pluxel/workbench': minor
  '@pluxel/create': patch
---

## Consolidate service domains and application composition

Management, Logging and official presets now belong to Services, retaining separate source domains and browser/server entry points. Use @pluxel/services/management, /logging, /preset, /vite, /build and /test instead of separate package installations. The Workbench Shell belongs to Workbench rather than a separate private workspace. Package-level mutual references are permitted across isolated leaf entries; module initialization and resource ownership remain explicit.
