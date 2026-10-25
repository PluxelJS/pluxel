## @pluxel/plugin-playwright@1.2.0

### Add external browser connections

Introduce a Playwright capability that connects to externally operated browsers over CDP or the native Playwright protocol without installing or launching a browser. Keep browser contexts scoped to their consumers and plugin lifetimes, and keep browser credentials in Vault. Unified fiscal/tax invoice workflows are released separately with the invoice package.

### Refresh workspace dependencies and generated tooling

Align shared UI consumers and generated project catalogs with React 19.3.1,
Mantine 9.7.3 and Vite+ 1.3.0. Rebuild precompiled Workbench assets against the
same shared versions. Refresh the documentation dependencies and update generated
project tool pins to the current supported Node 24 and pnpm 11 releases, hk 2.7.0
and Pitchfork 2.32.0.

Update the Federation Vite producer to 1.23.5, browser clients to Playwright
1.64.1, file watchers to Chokidar 6 and rendering dependencies to Takumi 2.17
and Pretext 1.0. Refresh the remaining workspace runtime and development catalogs.

The HTTP service now requires Elysia 2.0.0-rc.0. Use `onRequest` and `onError`
instead of the beta `request` and `error` hooks. Physical lifecycle registration
through `onStart` and `onStop` remains unavailable to Plugin-owned applications.

Canvas's exported Pretext helpers follow the 1.0 contract:
`layoutNextLine(prepared, maxWidth, cursor?)` and
`layoutNextLineRange(prepared, maxWidth, cursor?)`. Rich-inline source offsets
use `sourceStart` and `sourceEnd`; prepared handles expose read-only segments.

### Align the official Pluxel release line

Release the public framework packages and official Plugins together at 1.2.0. This is the maintainer's explicit version choice for the currently unpublished release; existing breaking-change descriptions remain part of the release notes. Future releases retain semver-based group bumps, and newly introduced pre-1.0 packages join the current release line.

Independent official Plugin packages use `@pluxel/plugin-*`. Update dependency names, package imports, subpath imports and application declarations together. This naming change preserves Plugin class names, exports and constructor declarations. Core, Host, Services, Workbench and tooling packages retain their existing names. Private Plugins remain workspace-only.

A Plugin's canonical identity includes its package entry. Rebuild consumer artifacts and explicitly review saved configuration, startup intent and Workbench state keyed by the previous identity before deployment; no old-name alias or automatic runtime migration is installed.

Carry forward the unpublished release notes. Earlier Host Dev notes belong to Host-vite; the former Typst Markdown extension belongs to the consolidated Markdown package. Their original explanatory bodies remain available alongside the later migration notes.
