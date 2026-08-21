---
packages:
  '@pluxel/cli':
    type: patch
  '@pluxel/rolldown':
    type: patch
  valibot-form:
    type: patch
---

## Restore complete workspace type checking

Fix CLI command collection, OIDC defaults and Ink overlay layouts under the current dependency types;
align Rolldown build configuration helpers with the current tsdown and nf3 contracts; and make
valibot-form development diagnostics safe in browser runtimes without a Node `process` global.
