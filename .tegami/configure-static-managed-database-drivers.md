---
packages:
  '@pluxel/rolldown':
    type: minor
  '@pluxel/runtime':
    type: patch
---

## Let static deployments omit unused managed database drivers

Add `managedDatabaseDrivers` to `staticApplication()` so deployments using an application-private
database, or only one Pluxel-managed backend, do not ship unused PGlite and PostgreSQL packages. Also
expose `sourcemapExcludeSources` for production maps that should retain mappings without embedded source.
Keep the runtime OXC resolver behind its actual synchronous call site so tree-shaken static applications
do not retain the unused native resolver package.
