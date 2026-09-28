## @pluxel/host@1.1.0

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

### Share Host development reports and HTTP assembly

Host development publishes update history through Host status and Management, including retained
candidates, application compensation and lifecycle issues. Update outcomes include `failed` when
startup or compensation leaves no active Host. Failed cleanup preserves the original diagnostics
and does not skip remaining settlement or compensation.

Official application presets delegate HTTP and management ingress to their owning services. Plugin
scaffolding consistently declares Core and validation dependencies.

### Keep dynamic file discovery with its Host owner

Use `@pluxel/host/dynamic` for file and directory sources and `@pluxel/host/dynamic/source-producer` for producer declaration checks. Dynamic discovery now ships with Host; applications no longer install a separate Host Dynamic package. Source discovery, updates, error reporting and cleanup retain the existing Host lifecycle.

### Consolidate Host application and development integration entries

Import `runHostApplication` from `@pluxel/host`, alongside the existing application contracts.
Remove the duplicate `/application` entry and update generated production launchers.

Host-dev exposes one explicit `/internal` entry for framework integration. Console execution,
IPC protocol, server and attachment implementations are private, with package-local tests
importing their source directly. The public console and Vite entries remain separate.

Portable execution snapshots and their validators now cross the browser/server boundary through `@pluxel/host/internal/protocol`. Management clients use this dependency-free entry instead of the server integration barrel; the duplicate execution exports and Management forwarding module are removed. Browser builds no longer traverse Host source loading and Node built-ins to validate update reports.

### Preserve invalid persistent Host documents

Host startup now rejects malformed or unsupported persisted config and runtime state documents instead of creating `.broken.*` copies and replacing the originals with empty state. The original document stays untouched; repair it or restore a backup before restarting. A failed load also keeps the store unready and blocks direct mutation.

### Drain Hosts with abstract provider defaults

Clear applied provider-default bindings in the same shutdown transaction that removes Plugin nodes,
so Hosts with abstract providers drain their generations successfully. Persisted provider selection
and startup intent remain available for the next startup.

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

### Report dynamic source failures with application updates

Publish dynamic discovery and missing-dependency recovery watcher errors through the same ordered
application update history used by candidate evaluation. Preserve running plugins and their individual
lifecycle history, and retain original errors in logs. Recovery hook failures are visible before a
candidate can start, without reporting an already recorded candidate failure twice.

### Recover initial dynamic entries and preserve execution attribution

Track separately evaluated dynamic roots even when the first candidate fails before a Host or catalog
exists. Syntax repairs retain unrelated service and Plugin generations; broad resolution retries are
reserved for missing imports. Snapshot source/built/unknown execution facts with each accepted catalog,
retain prior facts on rejection, and restore them when an application replacement needs compensation.

### Keep Plugin label projection independent of Host

Move the shared pure Plugin label functions to Core. Logging formatters and Management catalog projection now consume Core directly; Host no longer re-exports the implementation through its internal entry.

Remove manager creation, active-owner lookup, and Context binding functions from the Logging public root. Framework integrations retain the existing internal entry. Applications install `logging()` as a Host service and access the installed manager through `Logging` or `host.ctx.logging`.

### Retain and expose Plugin lifecycle failures

Plugin status and management commands include lifecycle failure codes and messages until recovery or removal, including across unrelated commits. Runtime logs record the affected Plugin, phase and serialized error. Workbench distinguishes startup failures and dependency blocking from pending activation, keeps error notifications open, and lets users copy the notification and full lifecycle report. PGlite initialization errors identify the data directory and explain why retrying a Plugin cannot recreate a failed shared backend.

### Add bounded third party version contracts

Add the optional `@pluxel/core/better-result` entry with all named exports from the shared `better-result` dependency.
Check the exact `capnweb` peer, development and installed versions when a plugin package publishes a
Workbench View or Attachment target. Move Vault Admin's `capnweb` to a peer and development dependency.
Record target publication in package metadata so static builds and dynamic source loaders share the
host `RpcTarget` constructor only for those publishers. Diagnose deployment version mismatches before
target evaluation. Improve the Workbench identity diagnostic and use Result within Auth credential
preparation while preserving its portable setup replies.

### Ship optional service UI plugins from one package

Import `VaultAdminPlugin` from `@pluxel/services/plugins`. The separate `@pluxel/vault-admin`
package is retired before this release. Vault resources remain owned by the explicitly installed
service; the optional Plugin publishes the Workbench view and uses the authenticated Management
session. Starter and maintenance applications use the same public entry.

Concrete Plugins may be exported from explicit package subpaths. Their canonical identity contains
the package name, export path and named export. A constructor exported through multiple public
paths or names is rejected, as are cross-package Plugin re-exports. Package root identities remain
unchanged. Compilation, inspection, persistence and packaged Workbench artifacts share this contract.

### Share framework identities with the application

Declare Core, Host and shared service/management contracts as peer dependencies with local
development copies. The compiler likewise consumes the application's Core lowering ABI.
Workbench declares React, Mantine and React Bridge as shared platform peers; owned implementation
libraries remain normal dependencies. This prevents integrations from silently installing their own
framework identities and makes compatible application dependencies explicit.

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

### Admit shared Workbench Cap'n Web before connecting module identity

Workbench now declares `capnweb` as a peer, while final Host applications provide the runtime directly. Development, static application builds, and production dynamic sources check a target publisher's peer and actual installed version before connecting its import to the Host Workbench module. A base library that supplies a Workbench target class is checked by its peer declaration even when it has no generated publication marker. Independent private RPC packages keep their own resolution. Source builds also require a matching development copy; installed publishers only require their published peer and installed runtime.
