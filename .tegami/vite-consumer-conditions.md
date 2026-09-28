---
packages:
  '@pluxel/rolldown': patch
---

## Keep Vite browser and server resolution separate

Preserve Vite's browser/server and development/production export conditions when enabling Pluxel source imports. Browser builds no longer select Node-only or development-only dependency entries.
