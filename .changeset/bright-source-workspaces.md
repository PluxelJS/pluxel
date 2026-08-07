---
'@pluxel/cli': minor
---

Add semantic cross-repository source workspaces with machine-local checkout registration, strict
diagnostics, runtime dependency-derived overlays, artifact-aware builds, and stable pnpm link proxies
that keep checkout paths out of project configuration and lockfiles. CI can use
`source install --frozen-lockfile` to reject lockfile drift across every participating checkout.
