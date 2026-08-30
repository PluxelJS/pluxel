---
packages:
  '@pluxel/runtime-dynamic':
    type: patch
---

## Transform legacy ESM module trees in dynamic hosts

Keep packages that publish an ESM tree through legacy `module` or `esnext` manifest fields inside
the Vite SSR graph instead of misclassifying their `.js` files as CommonJS host modules. Dynamic
Plugins can now load dependencies such as OpenTelemetry resources whose ESM output uses bundler-
resolved extensionless imports.
