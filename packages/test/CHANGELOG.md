## @pluxel/test@1.2.0

### Refresh shared external dependency ranges

Upgrade the shared runtime and tooling catalogs and use caret ranges for compatible stable releases. Align source consumers through the bundled pncat policy, including Elysia 2 beta.26 and current TypeBox. Preserve explicit prerelease, native pairing, patched dependency, and public peer compatibility exceptions.

Rebuild Workbench producer artifacts against the Mantine 9.7.1 compatibility set; the Shell and remote producers continue to require identical shared UI versions.

Generate starter catalogs through pncat using the same core version policy and Tegami package versions.

Handle declared optional dependencies whose platform packages are not installed, including dangling package-manager links, while keeping actual source imports strictly validated.

### Make filesystem fixture contracts truthful

Use `fixture.fsp` for Promise file operations. `fixture.fs` exposes callback, synchronous and stream
operations without inheriting conflicting Promise signatures. Missing callbacks now fail explicitly.
Memory fixtures reject `fs/tempDir` overrides; disk fixtures accept `tempDir` but always own native fs.

### Keep process-owned build orchestration inside the official CLI

`runWithTsdown` is no longer exported from the public `/build` entry. Official CLI cooperation uses
an explicit `/internal/cli` allowlist. Custom build hosts use the public `pluginPackage` preset.
The CLI runner owns one-shot bundle cleanup, including hook failures; watch resources, configuration
restarts and terminal interaction remain owned by the command process.

### Select Host inputs explicitly per policy and Plugin node

Replace `runtime.state`, `runtime.configRecords` and `runtime.plugins` with top-level
`policy` and `config`. Eight policy fields independently select `declared-only`,
`declared-first` or `saved-first`; configuration records select the same modes per
exact Plugin node, including package definitions and forks. Constructor owners
resolve to default nodes. Declaration does not create a fork, load code or seed a
saved record. Execution budgets are bound before PluginService creation and changes
require a new Host.

`runtime.documents.config/state` now describe document access separately from input
precedence. `false` performs no document I/O and keeps mutations within the Host
session; borrowed storage factories run once after the Core root is ready. Remove
the old public store option and overlay authoring types. State documents use sparse
v7 records and configuration uses v4 raw input records; applications must convert
existing data explicitly before startup.

### Preserve raw input through transactional management

Configuration writes use `{ set?, remove? }`; reset removes saved paths to restore
inheritance. Reads distinguish `managedInput`, `effectiveInput` and parsed `config`,
with source, shadowing, revision, persistence and adoption facts. Validation failures
retain editable input snapshots. Preview and failed writes never publish candidate
configuration. Supply `expectedManagedRevision` to reject stale edits. Management
exposes policy get/validate/patch/reset and reports changed columns and persistence
separately from runtime adoption.

Management protocol major 9 and ConfigPresentationPlanV2 remove evaluated schema
defaults from presentation. Workbench edits raw saved input, keeps shadowed inputs
editable, restores inheritance through reset and retains drafts on conflicts.
Schemas and transforms execute only through effective configuration validation.
Composite Plugin and Part schemas reject validation issues even when a validator
also returns a partial value, so invalid subtrees cannot be saved as valid output.

Dev Console uses `dev.policy` instead of `dev.state.inspect`. Inspection returns
`inputs.config` and identifies explicit fork bindings. Starter applications and test
Host authoring use the same configuration and mutation contracts.

### Keep native document reads from rewriting external replacements

Passthrough filesystem reads leave access-time updates to the native filesystem.
Closing a reader can no longer write a stale file size over a concurrently replaced
Host document, which previously could append NUL bytes to a shorter external edit.

### Complete Host ownership and retire the Runtime package

HostApplication is the single application contract for development and production. Environment facts
move to @pluxel/host/environment; applications explicitly select configuration and Vault deployment
inputs with `envBinding()` and `fileBinding()`. Production launchers use Host plus explicitly composed
HTTP services. The Runtime package,
its parallel Vite driver, production adapters, toolchain aliases and author barrels are removed.

RootContext.require accepts installed root/all capabilities; owner Context.require accepts owner/all
capabilities. Root references carry root authority and are not a sandbox. The development console can
therefore use dev.ctx.require without a separate service resolver or a new require namespace.

Management commands are an explicit @pluxel/services/management/commands service installed by servicesPreset.
Generic Commands and standardServices keep an initially empty command catalog. Regression suites,
benchmarks and type probes now live with their owning packages; test hosts use actual Host service plans.

The CLI no longer installs Workbench as an unused direct dependency; applications select it through
their own service composition.

### Refresh dependencies and source workspace synchronization

Update supported runtime, rendering, UI, test and build dependencies together, including the generated application and plugin toolchain pins. Rebuild the Workbench compatibility set with Mantine 9.7.4 and Module Federation Vite 1.23.9 / runtime and React bridge 2.9.3.

Prune source workspace scans to branches selected by declared workspace globs so unrelated artifact trees do not exhaust the scan budget. Preserve the directory bound and existing member validation.

Prepare the libSQL optional peer in the Services development checkout so source workspaces can share its Drizzle instance across PostgreSQL, PGlite and libSQL consumers.

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

### Unify runtime configuration and preserve raw saved input

Host applications, standalone Hosts and test Hosts now use top-level `name` and one `runtime` object containing `zenfs`, `logtape`, `tinybase`, `state` and `configRecords`. Core standalone constructors retain `name`. LogTape accepts native configuration or a root factory directly, with `{ input, options }` for framework policy; `logtape()` and `zenfs()` remain optional presets. Reference lowered Plugin nodes with `MyPlugin.nodeAddress()` or `MyPlugin.nodeAddress('fork')`.

Configuration uses `configRecords.records`; state declares its lists directly and stores fork node addresses. By default declarations initialize only missing documents. Explicit `override: true` affects the current runtime without overwriting saved data and makes controlled paths or state lists read-only to management. Saving preserves raw input, excluding schema defaults/transforms and environment overlays. Reset explicitly restores declared input; an empty key list does nothing. Inferred provider defaults remain runtime decisions.

Host configuration v4 and state v6 are ordinary FS documents under `services/host/<namespace>/<key>`. Previous document versions and TinyBase Host envelopes require explicit conversion; no compatibility reader or startup migration is retained. Configuration observes external file changes; state is loaded only at startup. FS retains atomic writes, bounded document size, subscription cancellation and close-time draining. TinyBase continues to own Plugin Stores.

Environment resolution requires explicit input. Native listeners receive hostname, port and publicOrigin from their launcher and do not read process environment. Service presets consume verified deployment facts. Dev-console inspection exposes declared, saved and effective configuration and state separately.

### One production-backed plugin test host

Import `createTestHost()` from `@pluxel/test`. Services are explicit and default to an empty list;
`workbench: true` adds the local test plane to the same host. Use `start/stop/restart`, typed batch
starts, catalog transactions, dependency overrides, configuration and native resource disposal.
The public Core and Services test factories are removed; Core graph harnesses remain internal.

Node/Worker source tests automatically attach the real artifact compiler when Node services are
selected without an explicit artifact source. Each host owns its compiler, temporary cache and
cleanup. Explicit packaged artifacts remain authoritative. The Vitest preset enables legacy
decorators and keeps project plugins explicit; separately built Node artifacts do not inherit
arbitrary Vitest plugins.

Official tests, generated plugin examples and testing documentation use the unified root entry.

### Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.

### Preserve native CommonJS and ESM resolution in Vitest

Remove the forced global `import` condition from the Vitest preset's Node conditions. CommonJS dependencies such as `pg` now select their native `require` exports while ESM imports keep their native branch. Framework source identity, condition ordering and compile-only type probe exclusions remain intact.

## @pluxel/test@1.1.0

### Make filesystem fixture contracts truthful

Use `fixture.fsp` for Promise file operations. `fixture.fs` exposes callback, synchronous and stream
operations without inheriting conflicting Promise signatures. Missing callbacks now fail explicitly.
Memory fixtures reject `fs/tempDir` overrides; disk fixtures accept `tempDir` but always own native fs.

### Keep process-owned build orchestration inside the official CLI

`runWithTsdown` is no longer exported from the public `/build` entry. Official CLI cooperation uses
an explicit `/internal/cli` allowlist. Custom build hosts use the public `pluginPackage` preset.
The CLI runner owns one-shot bundle cleanup, including hook failures; watch resources, configuration
restarts and terminal interaction remain owned by the command process.

### Complete Host ownership and retire the Runtime package

HostApplication is the single application contract for development and production. Environment facts
move to @pluxel/host/environment; applications explicitly select configuration and Vault deployment
inputs with `envBinding()` and `fileBinding()`. Production launchers use Host plus explicitly composed
HTTP services. The Runtime package,
its parallel Vite driver, production adapters, toolchain aliases and author barrels are removed.

RootContext.require accepts installed root/all capabilities; owner Context.require accepts owner/all
capabilities. Root references carry root authority and are not a sandbox. The development console can
therefore use dev.ctx.require without a separate service resolver or a new require namespace.

Management commands are an explicit @pluxel/services/management/commands service installed by servicesPreset.
Generic Commands and standardServices keep an initially empty command catalog. Regression suites,
benchmarks and type probes now live with their owning packages; test hosts use actual Host service plans.

The CLI no longer installs Workbench as an unused direct dependency; applications select it through
their own service composition.

### One production-backed plugin test host

Import `createTestHost()` from `@pluxel/test`. Services are explicit and default to an empty list;
`workbench: true` adds the local test plane to the same host. Use `start/stop/restart`, typed batch
starts, catalog transactions, dependency overrides, configuration and native resource disposal.
The public Core and Services test factories are removed; Core graph harnesses remain internal.

Node/Worker source tests automatically attach the real artifact compiler when Node services are
selected without an explicit artifact source. Each host owns its compiler, temporary cache and
cleanup. Explicit packaged artifacts remain authoritative. The Vitest preset enables legacy
decorators and keeps project plugins explicit; separately built Node artifacts do not inherit
arbitrary Vitest plugins.

Official tests, generated plugin examples and testing documentation use the unified root entry.

### Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.

## @pluxel/test@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
