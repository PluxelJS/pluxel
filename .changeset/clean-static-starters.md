---
'@pluxel/cli': minor
---

Make the built-in app monorepo and plugin starters reproducible pnpm 11 workspaces. Preserve generated
root gitignore files through npm packing, JSON-escape prompt values, use explicit defaults during
non-interactive generation, honor documented kebab-case CLI flags, and add production start, CI,
cache dependency, package-manager and workspace-governance safeguards.

Keep test resolution isolated when a generated repository is nested under another checkout by
giving each test-bearing workspace an explicit Vitest dependency and package-local configuration.
Keep external TypeScript programs on the plugin-only `@pluxel/hmr` condition so linked Pluxel
framework packages continue to resolve their built declarations instead of leaking framework source.

Exercise the installed CLI tarball in the release smoke test and package its complete local publish
dependency closure before verifying generated applications and plugins outside the source workspace.
