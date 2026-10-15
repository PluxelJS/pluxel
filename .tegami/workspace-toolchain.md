---
packages:
  '@pluxel/create': major
---

# Adopt mise, Vite+, hk and Pitchfork workspaces

Generate a workspace with pinned mise tools, Vite+ build tasks, hk checks and Git hooks, and Pitchfork
development services. Vite Task replaces Turbo, Vite+ Pack replaces the standalone tsdown command,
and `vp lint` / `vp fmt` replace standalone Oxlint and Oxfmt commands. Preserve build and lint rules
in their existing configuration files, referenced by `vite.config.ts` through `pack` and `lint`;
formatting is owned by the native `fmt` configuration. `vp check` unifies static checks; native
`verify` tasks compose governance, tests and builds without a custom runner. Package build scripts retain their public entry points
and delegate dependency ordering and output caching to Vite Task.

Replace the bundled Portless dependency and launcher with Pitchfork-managed ports and readiness.
Enable project-configured HTTP ingress on shared port 8088 without user configuration, certificate
trust or system networking changes. Include matching CI configuration and setup instructions, with
canonical workspace configuration documentation for users and coding agents.

Use Vite+ for installation, binary execution and package tasks, and `vp pm pack` for tarballs.
Mise prioritizes project-local executables; hk invokes the same `vp check` contract.
