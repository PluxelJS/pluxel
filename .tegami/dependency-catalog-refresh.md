---
packages:
  '@pluxel/cli': patch
  '@pluxel/create': patch
  '@pluxel/commands': patch
  '@pluxel/core': patch
  '@pluxel/host': patch
  '@pluxel/rolldown': patch
  '@pluxel/services': patch
  '@pluxel/test': patch
  'valibot-form': patch
  '@pluxel/workbench': patch
  '@pluxel/auth': patch
  '@pluxel/canvas': patch
  '@pluxel/fonts': patch
  '@pluxel/takumi-markdown': patch
  '@pluxel/takumi-markdown-typst': patch
  '@pluxel/wretch': patch
---

# Refresh shared external dependency ranges

Upgrade the shared runtime and tooling catalogs and use caret ranges for compatible stable releases. Align source consumers through the bundled pncat policy, including Elysia 2 beta.26 and current TypeBox. Preserve explicit prerelease, native pairing, patched dependency, and public peer compatibility exceptions.

Rebuild Workbench producer artifacts against the Mantine 9.7.1 compatibility set; the Shell and remote producers continue to require identical shared UI versions.

Generate starter catalogs through pncat using the same core version policy and Tegami package versions.

Handle declared optional dependencies whose platform packages are not installed, including dangling package-manager links, while keeping actual source imports strictly validated.
