---
packages:
  '@pluxel/workbench': major
  '@pluxel/services': patch
  '@pluxel/management': patch
---

## Separate management transport from the Workbench Shell

`workbenchHttp()` now owns only the Shell fallback. Compose `managementHttp({ bindings })`
explicitly for authenticated sessions and artifacts, declaring the `WorkbenchHost` preparation
dependency exported from `@pluxel/workbench/server`. The official services preset performs this
composition and keeps management HTTP/WebSocket access when Workbench is disabled.

Add `workbenchSourceShell({ entry })` to the existing development entry for explicit source Shell
serving through the current Vite server. Application frontend transforms remain application-owned.
The Shell service loads packaged assets on its first static request, allowing source development
without a prebuilt UI; the standalone packaged handler still validates assets when created.

HTTP mount factories expose the Host service contract without publishing their internal HTTP carrier dependency types, so importing their declarations does not pull Elysia into unrelated consumer type checking.
