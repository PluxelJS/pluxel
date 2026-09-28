## @pluxel/rolldown@1.1.0

### Declare applications with one deferred configuration factory

Applications now default-export `defineHostApplication(startup => ({ ... }))` from `@pluxel/host`.
The factory returns the complete application configuration, synchronously or asynchronously;
plain application exports and nested `configure` merging are removed. Each Host receives a
shallow immutable startup snapshot shared by its factory and `prepare` callback. The helper
preserves the inferred factory result and checks unsupported top-level fields.

### Keep development and production assembly consistent

Builds inspect inline factories without executing them and reject production plugin catalogs
that cannot be resolved statically. Module-level and imported constant plugin arrays remain
supported. Explicit environment and file bindings are described in the unified configuration change.

Re-evaluating an application factory replaces its Host; fixed-catalog execution reports this as
`host-reload`. Dynamic source-only updates retain catalog HMR when the application factory is
unchanged. Factory evaluation failures retain the running Host; failed replacement preparation
recreates a Host from the previous successful factory. The starter and application documentation
use the same factory declaration.

### Keep author dependencies out of build metadata writes

Plugin builds now reject missing or misplaced provider peers and incorrect optional peer markers. Builds only refresh generated Plugin publication facts; they no longer move or delete dependency declarations or fill repository fields from CI environment variables.

### Compose applications around one Plugin Host

Host owns catalog and lifecycle control, with a shared development driver and optional dynamic file
sources. Applications default-export `defineHostApplication(startup => ({ ... }))`, declaring
`plugins`, optional `sources`, `services` and `prepare`. Dynamic declarations perform no IO until the
Host opens their discovery session; producers validate declared coverage before creating resources.

### Unify development, builds and scaffolding

Use `vitePreset({ entry })` from `@pluxel/services/vite` and `buildPreset()` from
`@pluxel/services/build` for the official service composition. Custom compositions use
`host({ entry })` from `@pluxel/host-dev/vite` and `pluxel()` from `@pluxel/rolldown`.
Both use the same Host application declaration, including dynamic sources. Workbench and Node artifact
attachments are installed only for selected services; the development console is explicitly enabled.

The CLI no longer maintains HMR discovery profiles or their TUI. Declare fixed plugins and optional
file/directory sources in the application itself; inspect a running application with `pluxel dev`.

### Compose explicitly installed runtime services

Host creation is asynchronous and prepares an explicit service list before Plugin admission. Service
plans validate identity, properties, reserved Core members and dependencies before creating resources;
preparation and shutdown preserve dependency order and clean partially prepared resources on failure.
Core provides its own host composition entry, optional service type catalogs and synchronous token-based
Context.require(), with stable missing-capability and access errors.

Persistence and Vault move to dedicated @pluxel/services entries. Encrypted Vault explicitly requires
Persistence and flushes pending writes during Host cleanup; read-only deployment bindings need neither.
Import Persistence helpers and Vault types from their service entries. The Runtime package is removed;
servicesPreset() supplies the official default service composition.

### Preserve identity through development and generated metadata

Host development passes service declarations through the shared Host path. Service declaration changes
replace the Host; failed asynchronous preparation creates a fresh compensation Host from the previous
successful declaration. Native ESM and evaluated plugins share official service identity. Plugin/config
metadata defaults to the Core toolchain, without requiring Runtime in independent service applications.

### Unify plugin authoring and service ownership

Plugin examples and official packages import the Core authoring model directly. Commands, Node modules
and Workers are explicitly installed services; their tokens, declarations and types live at the service
entries. Worker installations declare their Node module dependency. servicesPreset() combines these
installations without introducing a second application or lifecycle model. The default Core author entry no longer forwards raw
Context host construction helpers; service authors use @pluxel/core/host.

Host exposes generic configuration get/validate/patch/reset through its existing coordinator, preserving
Core validation, storage confirmation and generation notification. Management delegates to these
operations and retains browser report projection. Vault operations participate in owner and root
admission: stop drains accepted work, rejects cached handles and flushes after pending storage IO.

### Use standard tsdown application plugins

Applications configure entry and output through tsdown and install pluxel() from @pluxel/rolldown in
the ordinary plugins list. This replaces the application preset in the build subpath, retaining the
same freezer, artifact assembly and deployment validation.

### Separate business HTTP from management

Install elysia() from @pluxel/services/elysia and use ctx.require(ElysiaApp) for the native generation-owned
Elysia application. Independent Hosts expose business requests through createElysiaHandler(host),
without management, Workbench or a listener. Official presets use the same installation and publication stages.
Host services may bind fixed Core lifecycle stages before Plugin admission; no dynamic registration or
secondary graph commit is introduced.

### Persist and manage Host state directly

Host owns configRecords and state.initial, optional borrowed document storage, read-only handling and
flush failure reporting. Status snapshots and retained lifecycle diagnostics, startup intent, provider
selection and fork operations share the same Host coordinator in standalone and default applications.
Service removeNodeMetadata hooks run before durable fork removal; failure retains the stopped fork so
cleanup can be retried.

Database moves from @pluxel/runtime/database to @pluxel/services/database. Install an explicit backend
from @pluxel/services/database/pglite or /postgres. Driver dependencies are optional and only the chosen
backend is imported. Missing installation reports the standard capability error. Database acquisition
and cached handle operations participate in root and owner drain; closing waits for accepted transactions.

### Share management, Workbench and development tooling

The authenticated management endpoint/client, Workbench publication/browser code and logging backend
move to independently selected packages. Vault administration is an ordinary explicitly installed Plugin.
Host-dev owns the existing local console executor and typed script surface at @pluxel/host-dev/console;
its Vite Host plugin accepts devConsole: true. Node and Workbench artifacts use ordinary Vite plugins and
the shared Host candidate boundary. Canceled management work is rejected before queued execution starts;
an admitted operation retains its existing completion and persistence semantics.

### Share startup declarations and transport ownership

Application startup and service test-host factories await the same createHost service preparation path. Official
plugins import validation and RPC contracts from their owning packages, removing the Runtime peer
where no runtime implementation is used. Services owns the Node HTTP/WebSocket carrier; Host-dev owns
the development console, and queued management mutations honor cancellation before admission.

The root `@pluxel/services` entry contains only `standardServices()` and its base service types. Import the official `servicesPreset()` from `@pluxel/services/preset`; its Management and Logging configuration types remain owned by those packages and do not leak into independent base-service consumers. Generated hosts and current examples use the explicit preset entry.

### Use one Core metadata ABI for Plugin source

Plugin and configuration lowering now emit only `@pluxel/core/toolchain` imports. Remove Runtime
preset selection and configurable metadata helper imports. `pluginSourceVitePlugins()` provides the
complete source transform and Vite resolution stack; `createPluginSourceVitePipeline()` additionally
exposes its semantic collector. Host and service singleton policy belongs to their own Vite plugins.

The official service Vite preset explicitly installs server database source lowering, preserving
checked migration metadata without a Runtime preset.

Installed modules under `node_modules` contribute execution facts only when they contain a valid
prelowered Core ABI declaration. Their ordinary source remains outside Plugin lowering. Settled
semantic scopes read committed Workbench facts, including asynchronous continuations after rollback.
Prelowered evidence accepts minified static template strings and reads only the ABI identity fields;
unrelated dependency expressions do not discard a statically proven definition.

### Define explicit console executions with one inferred context

Add `defineDevConsole()` and move execution id, input and cancellation signal onto `dev`.
Lifecycle and configuration operations return address-only Host report snapshots shared with
Management, preserving lifecycle failures and saved-but-not-applied outcomes. Inspect application
update failures through `dev.updates.latest()`, including failures before a Plugin enters the catalog.

### Retain development startup injection and URL presentation

Host and service Vite integrations accept immutable startup binding snapshots. Workbench and HTTP
attachments present the active shell mount and Portless application origin across Host replacement.

Prepared development artifacts now activate at graph acceptance before replacement Plugin startup.
Workbench Content-to-View updates retain the same Host and can start against their new artifacts;
pre-acceptance graph rejection still discards candidate artifacts. Shell navigation no longer claims
CSS requests whose Accept header also includes a wildcard.

### Admit installed Workbench artifacts during development

Development attachments receive the exact candidate module closure and selected definitions.
Installed Plugin inventories now participate in the same artifact preparation, acceptance, and
withdrawal as source Plugins. Unselected exports do not require their artifact directories.
Rejected candidates retain accepted artifacts; Host compensation reuses accepted plans and reports
failure if their immutable disk revisions are no longer available. Physical installed modules can
contribute positive prelowered ABI facts without enabling source lowering for third-party packages.

Prebuilt Workbench shell assets carry Vite's HTML ignore markers, preventing false source-module
pre-transform failures while preserving the HTML pipeline, Vite client injection, and source Shell HMR.

### Preserve cancellation and resource failure diagnostics

Cancelled executions keep their cancellation reason in `error` and retain a distinct thrown
execution/resource failure in `executionError`. Compound error messages preserve bounded child
diagnostics, including `using` disposal failures, without interpreting arbitrary AggregateError
children as execution and cleanup phases.

### Preserve Vite source resolution and browser diagnostics

Enable Vite tsconfig path resolution by default while respecting an explicit `false`. Classify
alias-resolved CommonJS files through the same Node execution boundary as installed dependencies.
Report browser imports of Node builtins immediately with their importer, while allowing explicit
browser implementations and leaving server imports unchanged.
Normalize Vite filesystem IDs consistently for recovery and host module classification, including
Windows drive paths, duplicate POSIX slashes, and query/hash suffixes.

Remove the unused Host-dev `hmr-log` entry and root log-schema exports. Application update reports
and plugin lifecycle reports remain the authoritative development diagnostics.

### Make filesystem fixture contracts truthful

Use `fixture.fsp` for Promise file operations. `fixture.fs` exposes callback, synchronous and stream
operations without inheriting conflicting Promise signatures. Missing callbacks now fail explicitly.
Memory fixtures reject `fs/tempDir` overrides; disk fixtures accept `tempDir` but always own native fs.

### Keep process-owned build orchestration inside the official CLI

`runWithTsdown` is no longer exported from the public `/build` entry. Official CLI cooperation uses
an explicit `/internal/cli` allowlist. Custom build hosts use the public `pluginPackage` preset.
The CLI runner owns one-shot bundle cleanup, including hook failures; watch resources, configuration
restarts and terminal interaction remain owned by the command process.

### Isolate Host development in its own Vite environment

Host development owns the dedicated `pluxel` environment. Application modules, dynamic plugins, and the development console share its runner, source conditions, singleton identities, semantic collector, and queued HMR. Default SSR and third-party `ssrLoadModule` retain Vite's own environment and are unaffected by Host module policy; custom SSR factories can coexist.

Vite resolves modules before the Host environment chooses native Node evaluation for CommonJS, native modules, and explicit singletons. Vite owns the runner and cleanup. Services scope database source transforms and transport externalization to the Host environment, and HTTP diagnostics preserve the runner's source maps without reprocessing them through another environment's graph.

Remove incidental public runner, classifier, and invalidation helpers from `@pluxel/host-dev/vite`. Use `host()` or the Services preset; combine `hostSingletons()` with that Host environment. The reserved `pluxel` environment factory cannot be replaced. Concrete source pipelines now bind their semantic collector to one named environment (default `ssr`). Legacy decorator syntax remains project-wide because Vite does not expose per-environment OXC options.

Initial Host and recovery failures now render their original stack, nested causes, and aggregate errors in Vite's terminal message, preserving the original Error for Vite's reporting bookkeeping.

Host and recovery diagnostics now share one internal structured logging entry that follows the current Host logger across replacement, falling back to the user's Vite logger before startup. It does not replace `customLogger` or install additional sinks.

### Consolidate Host application and development integration entries

Import `runHostApplication` from `@pluxel/host`, alongside the existing application contracts.
Remove the duplicate `/application` entry and update generated production launchers.

Host-dev exposes one explicit `/internal` entry for framework integration. Console execution,
IPC protocol, server and attachment implementations are private, with package-local tests
importing their source directly. The public console and Vite entries remain separate.

Portable execution snapshots and their validators now cross the browser/server boundary through `@pluxel/host/internal/protocol`. Management clients use this dependency-free entry instead of the server integration barrel; the duplicate execution exports and Management forwarding module are removed. Browser builds no longer traverse Host source loading and Node built-ins to validate update reports.

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

### Publish Node artifacts for every concurrent build

Deduplicate compilation without skipping each consumer's output directory or native dependency
report. Concurrent builds of the same source now each receive their artifact and deployment facts.

Compile native dependency bridges relative to the final artifact directory, not the disk cache.
Include the output layout in the cache identity so nested output directories remain loadable.

Keep cached bytes leased until every concurrent consumer finishes publishing, including during cache eviction.

### Preserve installed-package resolution failures

OXC-backed resolution now reports an installed package's invalid or unreadable manifest and rejected exports with its importer and original cause. Ordinary missing packages still return no match.

### Locate Plugin configuration in a selected application

Extend `project.plugin()` with an explicit `application` context and an `inputs` section for config
environment/file bindings, schema references, and the application `configRecords` expression. Support
targeted source-entry Plugins using the compiler's source-space identity rules. Application queries
resolve actual package sources from the selected entry rather than substituting workspace packages.

Share declaration facts between build transforms and inspection without evaluating application or
schema factories. Preserve actionable source locations for analysis gaps and propagate exhausted
read budgets as query failures. Existing workspace discovery and file ownership scopes stay unchanged.

### Inspect Plugin source from ordinary TypeScript

Add `@pluxel/rolldown/inspect` with `openProject()` for workspace overview, package-root Plugin
discovery, PluginPart/config/dependency navigation, declared package checks, and reverse file ownership.
Queries reuse compiler semantics without evaluating project code, return source locations and explicit
analysis gaps, and reread source between calls. Results use existing Plugin identity and remain detached
from the query scope and running applications.

Correct workspace parsing so YAML lists after the pnpm `packages` block are not treated as workspace
members.

### Infer Plugin package identity from TypeScript source exports

Use the same source selection for package inference and explicit package plans. Workspace packages
whose root export points directly, or through `import` / `default`, to TypeScript retain package-root
identity without a duplicate `@pluxel/hmr` condition. Recognize `@pluxel/source` and `development`
consistently, while excluding declaration files and ordinary built JavaScript exports.

### Add bounded third party version contracts

Add the optional `@pluxel/core/better-result` entry with all named exports from the shared `better-result` dependency.
Check the exact `capnweb` peer, development and installed versions when a plugin package publishes a
Workbench View or Attachment target. Move Vault Admin's `capnweb` to a peer and development dependency.
Record target publication in package metadata so static builds and dynamic source loaders share the
host `RpcTarget` constructor only for those publishers. Diagnose deployment version mismatches before
target evaluation. Improve the Workbench identity diagnostic and use Result within Auth credential
preparation while preserving its portable setup replies.

### Refresh the Workbench Federation profile

Use Module Federation Vite 1.22.1 with Runtime, SDK and React Bridge 2.9.1 and Mantine 9.6.3. The exact producer and Shell compatibility checks remain enforced; rebuild renderer artifacts with the updated profile.

Keep shared-surface import analysis, application-root scheduling and isolated declaration caches: real Mantine producer builds and upstream shared state still require these boundaries with the updated plugin.

### Collapse implementation paths into deliberate service boundaries

Import `createElysiaHandler` from `@pluxel/services/elysia` and `listenElysia` from
`@pluxel/services/elysia/node`. The application, listener and private asset-file subpaths are removed.
Generated launchers and starter applications use these shared domain entries.

Private service implementation files are no longer exported individually. Framework owner-view and
security integration uses the narrow `@pluxel/services/internal` entry; white-box test support retains
`/internal/test`. Persistence and Vault contracts come from their existing public domain entries.
Database drivers remain private package imports, preserving lazy optional-backend loading.

`VaultAdmin` and the root `vaultAdmin` property expose the existing `VaultAdminApi` contract,
keeping the backend implementation and Host-only preparation method private.

### Share framework identities with the application

Declare Core, Host and shared service/management contracts as peer dependencies with local
development copies. The compiler likewise consumes the application's Core lowering ABI.
Workbench declares React, Mantine and React Bridge as shared platform peers; owned implementation
libraries remain normal dependencies. This prevents integrations from silently installing their own
framework identities and makes compatible application dependencies explicit.

### Reject incomplete workspace and package discovery

Workspace membership now comes from `pnpm-workspace.yaml`. Malformed selected manifests, invalid patterns, and scan IO failures stop discovery instead of silently dropping candidates. Host module classification stops at a broken package manifest, and OXC initialization and thrown resolution failures retain their causes.

### Reuse exact source parses across transform stages

Keep original and transformed module parses in the same bounded cache instead of evicting each
other. Reuse imported PluginPart analysis within one resolution operation. Reject standalone OXC
recovery ASTs with syntax errors so malformed source cannot produce accepted lowering facts.

### Adopt the tsdown 0.23 build handle

The official CLI runner consumes the native build handle while preserving one-shot hook completion and bundle cleanup, including cleanup errors. Watch remains owned by the command process and native tsdown controls. Remove the obsolete dependency diagnostic field; use tsdown's `deps.neverBundle` configuration.

### Bind deployment inputs and preserve editable configuration layers

Application factories declare `envBindings` and `fileBindings` with `envBinding` and
`fileBinding`, importing the configuration and Vault root schemas explicitly. Binding helpers
check schema input keys; Plugins keep `configs.use(schema)` without static schema fields.
Bindings require Valibot schemas, matching the Host's input projection at runtime.
Host verifies that a config binding references the same schema as the Plugin's lowered declaration.
Static builds derive `.env.example` from the explicit schemas without evaluating factories or
reading deployment values. Published declarations provide field completion without compiler plugins.
Config merges base, saved values, and environment overrides recursively, replacing arrays.
Only management edits persist. Environment-controlled paths reject writes, and management
responses expose value-free source metadata. The previous environment bootstrap helper and
implicit `PLUXEL_CONFIG` snapshot are removed.

### Use structured Vault snapshots with durable writes and deployment records

Vault KV reads return immutable snapshots with revision, source, and writability. Writes support
expected revisions, batches publish only after durable commit, and owner-scoped subscriptions
observe committed changes. Environment/file records are whole-record read-only overlays;
bindings-only installations need neither Persistence nor disk keys. Encrypted Vault takes an
explicit deployment identity. Named namespaces are owner-local; legacy global namespaces require
explicit owner migration mappings. Legacy documents migrate to collision-checked KV keys.
Vault root schemas validate record keys and complete records as an application startup contract;
Plugin hot replacement does not change that contract or repeat input transforms.

Official authentication and storage plugins export their deployment schemas, consume structured
credential records, and observe updates. The showcase and local applications migrate their
credential and account workflows.

Vault administration displays KV and blob counts for the unified storage model.

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

### Keep Vite browser and server resolution separate

Preserve Vite's browser/server and development/production export conditions when enabling Pluxel source imports. Browser builds no longer select Node-only or development-only dependency entries.

### Preserve resolved Vite environment values in conditional compilation

Register preprocessor configuration hooks at the top level and use native environment filtering for transforms. Source pipelines now honor the selected Vite mode and its loaded environment values when choosing conditional branches.

### Recover Workbench definition hot updates across edits, failures and file replacement

Refresh standalone Workbench definitions and imported helpers within the same semantic generation as Plugin facts. Reject superseded transforms, discard failed parsing work, withdraw deleted publications, and preserve committed facts when a candidate is rejected. Generated Bridge and renderer projection files now use revision-specific paths.

Host Vite development handles file creation and deletion through the same update queue as edits, allowing recreated definitions and their dependent plugins to recover without restarting dev.

### Report selected Workbench runtime manifest failures

Workbench publisher and static application checks now report the selected package manifest or workspace catalog path and retain the underlying read or parse error. An inaccessible selected path no longer causes an ancestor manifest or catalog to be used; malformed JSON and YAML identify the file that failed.

### Match renderer JSX to the shared Shell runtime

Use production-compatible JSX calls even for development renderers, so a packaged Shell can render them without jsxDEV. Invalidate cached renderer revisions.

### Admit shared Workbench Cap'n Web before connecting module identity

Workbench now declares `capnweb` as a peer, while final Host applications provide the runtime directly. Development, static application builds, and production dynamic sources check a target publisher's peer and actual installed version before connecting its import to the Host Workbench module. A base library that supplies a Workbench target class is checked by its peer declaration even when it has no generated publication marker. Independent private RPC packages keep their own resolution. Source builds also require a matching development copy; installed publishers only require their published peer and installed runtime.

### Keep implementation modules private

Remove unused Workbench `/paths`, `/internal/shell` and `/internal/definition` exports and the unused
Rolldown `/internal/static-config-environment-vite` adapter. Package-local white-box tests import
source modules directly. The generated browser React Bridge ABI remains isolated at
`@pluxel/workbench/internal/react`.

Workbench owner publication now captures the owner directly in the frozen `publish()` capability, removing the intermediate `WorkbenchService` wrapper while preserving PluginPart rejection and backend admission. Remove the unused `createWorkbenchBackend` factory and `WorkbenchBackendFactory` type; custom internal test assembly still injects a backend through the shared service installation path. Shell asset paths are owned locally by Workbench.

### Fingerprint type-only package exports without a runtime entry

Workbench artifact builds now include installed declaration-only packages such as `@types/react` in the dependency revision without trying to resolve a nonexistent JavaScript root. Packages that declare a runtime root still fail on a broken export.

## @pluxel/rolldown@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
