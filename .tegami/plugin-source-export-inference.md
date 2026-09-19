---
packages:
  '@pluxel/rolldown': patch
---

## Infer Plugin package identity from TypeScript source exports

Use the same source selection for package inference and explicit package plans. Workspace packages
whose root export points directly, or through `import` / `default`, to TypeScript retain package-root
identity without a duplicate `@pluxel/hmr` condition. Recognize `@pluxel/source` and `development`
consistently, while excluding declaration files and ordinary built JavaScript exports.
