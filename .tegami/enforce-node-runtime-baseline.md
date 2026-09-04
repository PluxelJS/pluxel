---
packages:
  '@pluxel/agent-tools':
    type: major
  '@pluxel/auth':
    type: major
  '@pluxel/canvas':
    type: major
  '@pluxel/cli':
    type: major
  '@pluxel/commands':
    type: major
  '@pluxel/context':
    type: major
  '@pluxel/core':
    type: major
  '@pluxel/echarts':
    type: major
  '@pluxel/fonts':
    type: major
  '@pluxel/rolldown':
    type: major
  '@pluxel/runtime':
    type: major
  '@pluxel/runtime-dynamic':
    type: major
  '@pluxel/runtime-static':
    type: major
  '@pluxel/takumi':
    type: major
  '@pluxel/test':
    type: major
  '@pluxel/wretch':
    type: major
  valibot-form:
    type: major
---

## Require the supported Node runtime

All published Pluxel packages now declare Node.js `>=24`, matching the workspace and generated-project
baseline. This makes the runtime requirement visible to package managers and keeps the Vitest 5/Vite
toolchain contract consistent for standalone consumers.
