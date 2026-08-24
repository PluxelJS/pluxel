---
packages:
  '@pluxel/create':
    type: patch
  '@pluxel/rolldown':
    type: minor
  '@pluxel/runtime':
    type: patch
  '@pluxel/runtime-static':
    type: minor
  valibot-form:
    type: minor
---

## Bootstrap static Plugin config from deployment environment

Add typed `bindConfigEnvironment()` declarations to static applications so deployment variables can
initialize Plugin raw config through the existing ConfigService authority. Bindings reuse the exact
schema passed to `configs.use()`, derive string, number, boolean, or JSON transport from its raw input,
and preserve persisted config over later environment changes.

Static builds validate the same direct declaration syntax used by Vite and generate a deterministic
root `.env.example` from schema descriptions and portable constraints. The generated asset never
reads build environment values or duplicates schema defaults. The starter demonstrates the binding
without introducing a second config system.
