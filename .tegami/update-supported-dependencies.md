---
packages:
  '@pluxel/cli':
    type: patch
  '@pluxel/create':
    type: patch
  '@pluxel/test':
    type: patch
  '@pluxel/commands':
    type: patch
  '@pluxel/host-vite':
    type: patch
  valibot-form:
    type: patch
  '@pluxel/plugin-auth':
    type: patch
  '@pluxel/plugin-canvas':
    type: patch
  '@pluxel/plugin-echarts':
    type: patch
  '@pluxel/plugin-fonts':
    type: patch
  '@pluxel/plugin-takumi-markdown':
    type: patch
  '@pluxel/plugin-takumi':
    type: patch
  '@pluxel/plugin-wretch':
    type: patch
---

## Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.
