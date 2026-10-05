---
packages:
  '@pluxel/cli': minor
  '@pluxel/host-vite': minor
  '@pluxel/create': patch
---

# Bind development packages, documentation and skills to one source

Git CLI setup uses its owning checkout instead of a global Pluxel override, manages ignored docs/skill links and records workspace setup. CLI releases include offline development resources; `workspace setup` materializes them and `docs` reads their contents. Development hosts check project setup before startup. Generated project instructions describe the unified setup flow.
