# Eventure source in Pluxel

Imported from [PluxelJS/Eventure](https://github.com/PluxelJS/Eventure) at
`f2aa42919b105372566e39673b5eefcb316b5876` (version `0.5.0`). The original
license is in [LICENSE](./LICENSE).

This workspace copy is the Eventure implementation used by Pluxel Core. Core
links it during development and bundles its JavaScript and declarations for
publication, so Pluxel consumers do not install `eventure` for Core. Eventure
remains a separate upstream package with its own release history; Pluxel's
Tegami release does not publish this vendor workspace.

When changing Eventure here, run its typecheck and tests, then build Core and
check the packed Core entry and declarations. Update this snapshot reference
when importing another upstream revision.

The vendor workspace uses Vitest for tests so Pluxel's Node and pnpm CI toolchain
can run them. Its source and package contract came from the upstream revision
above; test runner changes are local to this workspace copy.
