---
packages:
  '@pluxel/cli':
    type: patch
---

## Bootstrap source workspaces without a project-local CLI

Allow the `pluxel source` command family to run from an independently installed CLI when a consumer
declares `@pluxel/cli` but has not installed it yet. Other commands remain pinned to the project-local
CLI and fail instead of silently falling back. Source checkout registration and installation now use
the public CLI workflow directly, without a repository-specific bootstrap script. Project-local CLI
resolution is also contained within the nearest Git, workspace, or package-manager lockfile boundary,
so a nested independent checkout cannot accidentally consume its parent project's CLI.
