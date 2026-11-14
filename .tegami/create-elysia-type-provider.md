---
packages:
  '@pluxel/create': patch
---

# Provide matching type environments for starter Plugins and project scripts

Generated Host and HTTP Plugin packages now declare `@types/bun` as a development
dependency because Elysia's public declarations import types from `bun`. The
starter can generate Plugin control materials without relying on a transitive
type provider.

The starter also provides `host/web/dev/tsconfig.json`, inheriting the Host's
Node types, source export conditions, and decorators. Development scripts in
that directory check the same Plugin source modules that the server evaluates;
the frontend retains its separate compilation environment.
