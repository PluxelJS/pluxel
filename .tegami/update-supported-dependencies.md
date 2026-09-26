---
packages:
  '@pluxel/cli': patch
  '@pluxel/create': patch
  '@pluxel/test': patch
  '@pluxel/commands': patch
  '@pluxel/host-dev': patch
  'valibot-form': patch
  '@pluxel/auth': patch
  '@pluxel/canvas': patch
  '@pluxel/echarts': patch
  '@pluxel/fonts': patch
  '@pluxel/takumi-markdown-typst': patch
  '@pluxel/takumi-markdown': patch
  '@pluxel/takumi': patch
  '@pluxel/vault-admin': patch
  '@pluxel/wretch': patch
---

## Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.
