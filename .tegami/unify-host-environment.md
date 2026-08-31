---
packages:
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-static':
    type: minor
  '@pluxel/runtime-dynamic':
    type: patch
  '@pluxel/rolldown':
    type: minor
  '@pluxel/create':
    type: patch
---

## Unify Pluxel host environment and platform diagnostics

Expose the universal `std-env` environment through `@pluxel/runtime/environment`, with typed,
augmentable official `PLUXEL_*` variables and one validated `hostEnv` view. Its `dataRoot` always has
the shared `.pluxel` default; Pluxel persistence and database/cache integrations own separate child
directories without duplicating `PLUXEL_DATA_ROOT` fallback logic. Static and dynamic
launchers, generated production bootstraps, Vite configs, and the starter now consume this shared
environment instead of reading `process.env` independently.

Apply `PLUXEL_DATA_ROOT`, `PLUXEL_WORKBENCH`, listener, and TLS policy consistently. Workbench static
artifacts are enabled by default unless explicitly disabled, while headless artifacts remain unable to
install the UI. Static builds always emit a documented `.env.example`, appending typed Plugin config
bootstrap variables when declared.

Publish a non-secret `std-env` platform snapshot through Management protocol v3 and show it on
the Workbench home screen, including a clear warning for Worker/edge runtimes without exposing raw
environment values.
