---
packages:
  '@pluxel/core':
    type: minor
  '@pluxel/host':
    type: patch
  '@pluxel/rolldown':
    type: minor
  '@pluxel/services':
    type: minor
  '@pluxel/workbench':
    type: patch
  '@pluxel/create':
    type: patch
---

## Ship optional service UI plugins from one package

Import `VaultAdminPlugin` from `@pluxel/services/plugins`. The separate `@pluxel/vault-admin`
package is retired before this release. Vault resources remain owned by the explicitly installed
service; the optional Plugin publishes the Workbench view and uses the authenticated Management
session. Starter and maintenance applications use the same public entry.

Concrete Plugins may be exported from explicit package subpaths. Their canonical identity contains
the package name, export path and named export. A constructor exported through multiple public
paths or names is rejected, as are cross-package Plugin re-exports. Package root identities remain
unchanged. Compilation, inspection, persistence and packaged Workbench artifacts share this contract.
