# Pluxel Projects

`projects/` only contains runnable applications that must evolve in the Pluxel repository-level
workspace. The current and intentionally small set is:

| Project       | Purpose                                                                      |
| ------------- | ---------------------------------------------------------------------------- |
| `plugin-host` | Dynamic/static route development, HMR diagnostics and focused runtime demos. |
| `docs`        | Fumapress/Waku site built from the repository's `docs/` Markdown source.     |

Product-scale applications have independent Git history, lockfiles, CI and release lifecycles.
During cross-repository development they consume the current Pluxel checkout through
[`pluxel source`](../docs/development/source-workspaces.md), rather than becoming nested members of this
workspace.

For a new application, generate the canonical standalone monorepo:

```bash
pluxel new --template app-monorepo --name @acme/my-app
```
