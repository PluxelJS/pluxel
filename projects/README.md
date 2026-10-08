# Pluxel Projects

`projects/` contains reference applications that must evolve in the Pluxel repository-level
workspace, including explicitly marked designs awaiting implementation. The current and intentionally small set is:

| Project                                            | Purpose                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `plugin-host`                                      | Native modules delivery, Vite execution, HMR diagnostics and focused runtime demos.          |
| `docs`                                             | Fumapress/Waku site built from the repository's `docs/` Markdown source.                     |
| [`embedded-launcher`](embedded-launcher/README.md) | Design only: native UI, Node/Vite development HMR and an embedded QuickJS-NG plugin runtime. |

Product-scale applications have independent Git history, lockfiles, CI and release lifecycles.
During cross-repository development they consume the current Pluxel checkout through
[`pluxel source`](../docs/development/source-workspaces.md), rather than becoming nested members of this
workspace.

For a new application, generate the canonical standalone monorepo:

```bash
pnpm create @pluxel my-workspace
```
