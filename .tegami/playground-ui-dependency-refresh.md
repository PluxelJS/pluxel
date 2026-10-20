---
packages:
  '@pluxel/core': patch
  '@pluxel/cli': patch
  '@pluxel/create': patch
  '@pluxel/host-vite': patch
  '@pluxel/rolldown': patch
  '@pluxel/services': major
  '@pluxel/test': patch
  '@pluxel/workbench': patch
  valibot-form: patch
  '@pluxel/plugin-auth': patch
  '@pluxel/plugin-fonts': patch
  '@pluxel/plugin-takumi': patch
  '@pluxel/plugin-wretch': patch
  '@pluxel/plugin-invoice': patch
  '@pluxel/plugin-playwright': patch
  '@pluxel/plugin-canvas': major
---

# Refresh workspace dependencies and generated tooling

Align shared UI consumers and generated project catalogs with React 19.3.1,
Mantine 9.7.3 and Vite+ 1.3.0. Rebuild precompiled Workbench assets against the
same shared versions. Refresh the documentation dependencies and update generated
project tool pins to the current supported Node 24 and pnpm 11 releases, hk 2.7.0
and Pitchfork 2.32.0.

Update the Federation Vite producer to 1.23.5, browser clients to Playwright
1.64.1, file watchers to Chokidar 6 and rendering dependencies to Takumi 2.17
and Pretext 1.0. Refresh the remaining workspace runtime and development catalogs.

The HTTP service now requires Elysia 2.0.0-rc.0. Use `onRequest` and `onError`
instead of the beta `request` and `error` hooks. Physical lifecycle registration
through `onStart` and `onStop` remains unavailable to Plugin-owned applications.

Canvas's exported Pretext helpers follow the 1.0 contract:
`layoutNextLine(prepared, maxWidth, cursor?)` and
`layoutNextLineRange(prepared, maxWidth, cursor?)`. Rich-inline source offsets
use `sourceStart` and `sourceEnd`; prepared handles expose read-only segments.
