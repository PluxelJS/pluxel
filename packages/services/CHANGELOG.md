## @pluxel/services@2.0.0

### Use the application build entry directly

Remove `buildPreset()` and the `@pluxel/services/build` export. Application builds use `pluxel()` from `@pluxel/rolldown`; delivery, Workbench variant, launcher and residual dependency options keep their existing behavior and defaults. Runtime service and Vite attachment presets retain their distinct contracts.

Generated hosts and the official Host example import the same application build entry. No compatibility alias or forwarding entry remains.

### Native modules delivery and owned Vite execution

Replace Host dynamic source execution with pure `@pluxel/host/sources` declarations. Native startup accepts a precompiled application module path and binds shared packages before evaluating its factory and fixed imports, then scans sources once, validates shared package versions and loaded artifact inventories, and reports next-start consumption. `createHost()` accepts evaluated Plugins only.

Rename Host Dev to `@pluxel/host-vite`. Its root configures the same update driver for development and production; `/run` owns production startup and close, while `/console` remains development-only. Execution diagnostics explicitly distinguish native/Vite, fixed/source, artifact and update behavior. Workbench runtime artifact attachments move to `/vite`.

Execution and build options are captured at owner creation. Source admission consistently rejects linked entry leaves with a located error. Host-vite observes rapid file repairs and drains accepted watcher work; production close releases remaining resources after failures and preserves its rejection on repeated calls. Artifact candidate commit and rollback are synchronous contracts checked for JavaScript callers too.

Development startup distinguishes the workspace used by CLI doctor from the member package that declares the CLI. It preserves explicit configuration roots and project installation boundaries, and reports invalid setup through the existing doctor.

Add modules application delivery with an exported factory/product, unique compiled public exports, unchanged canonical identities and verified Node/Workbench inventories. Standalone remains the default fixed-catalog build. Generated hosts use modules with native startup and an independent production Vite example; CLI resources and documentation follow these contracts. Removed entry points and fields have no aliases.

Standalone delivery preserves traced native libraries in the `@pluxel` namespace through explicit residual selection; Core/Host identities remain bundled and traced duplicate framework copies are rejected. Native startup reuses successful namespace admission within its loader and stores cached entry closures as shared immutable prefix views. Vite validates its completed initial source observation once, while live updates and source consumers retain current validation.

Official published Plugins declare their artifact root and Node/Workbench inventory capabilities so installed consumers validate the compiled artifacts owned by the actual loaded package.

Standalone Workbench builds select producer and Content owners from the validated fixed catalog using the existing compiler's constructor bindings. Unselected definitions do not read renderer/Markdown inputs, build UI, or copy package artifact trees; selected inventories retain strict validation.

### Preserve runtime admission and resource ownership

Capture Host service, source, state and catalog selections before asynchronous preparation, and fix binding paths, namespaces and environment mappings before file reads. Reject unsupported Host and Vite options; generated standalone startup projects only Host configuration fields.

Validate production Vite constraints after config hooks. Keep the accepted dependency watcher until its replacement is ready, and release both during shutdown.

Generate modules exports and deployment entry from actual output chunks, including nested or hashed names; reject incompatible module extensions during the build.

Honor explicitly configured Node artifact roots and resolvers in Vite. A source-detach failure no longer skips pending setup drain or active consumer cleanup; aggregated failures retain their original cause.

## @pluxel/services@1.1.0

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

### Keep carrier handling inside publication ownership

Command mounts accept `{ install, handle? }` instead of an installer callback. The optional
handler receives the captured Command, untrusted input, and carrier context; authorization,
context projection, execution, and response presentation settle within the provider and
publisher invocations. A custom handler can project its own output type and construct a
command-specific context. Direct bindings still execute the selected Command unchanged.

Mounted endpoints carry an explicit marker and cannot be re-mounted as direct definitions.
The new `snapshotCommand()` captures and validates the descriptor and execute function without
creating a temporary registry, preserving the receiver and existing publication withdrawal.

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

### Consolidate service domains and application composition

Management, Logging and official presets now belong to Services, retaining separate source domains and browser/server entry points. Use @pluxel/services/management, /logging, /preset, /vite, /build and /test instead of separate package installations. The Workbench Shell belongs to Workbench rather than a separate private workspace. Package-level mutual references are permitted across isolated leaf entries; module initialization and resource ownership remain explicit.

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

### Expose the Elysia application directly and keep its dispatcher internal

Use `ElysiaApp`, `elysia()` and `createElysiaHandler(host)` from
`@pluxel/services/elysia`. Node applications use `listenElysia(host, options?)`
from `/elysia/node`; the srvx listener owns Host shutdown and needs no duplicate
fetch handler. Vite applications use `elysiaDevelopment()` from `/elysia/vite`.
Remove the HTTP service aliases and public dispatcher/carrier extension surface.
Route ownership, cancellation and WebSocket drain semantics remain unchanged.

### Adopt current Elysia, srvx and LogTape contracts

Use Elysia 2 beta.19's Web Standard adapter and bind the Plugin-owned server through
its request hook while keeping cancellation, WebSocket ownership and Host shutdown.
Use srvx 1.0.5 for Node listeners. Delegate exit-hook disposal and file value rendering
to LogTape 2.3.8, removing local listener interception and formatter workarounds.

Pin TypeBox to 1.3.23 until Elysia no longer uses the Validator internals removed in 1.3.24; preserve schema compilation before publication and cover it with real requests.

### Enforce persistence paths, readonly writes and consistent directory queries

Persistence rejects absolute paths, traversal and ambiguous path segments instead of repairing them.
Namespaces retain literal names including `@pluxel`; any existing files in the former sanitized
`_pluxel` namespace require a one-time move before using the new backend. No fallback reader is installed.
Memory and filesystem backends list sorted immediate children and stat directories. Readonly workspace
and custom service backends reject writes and deletes even without preflight. Filesystem roots are fixed
when the backend is created.

### Forward Host cancellation without losing HTTP carrier identity

Mounted Host endpoints receive the root invocation AbortSignal combined with client cancellation.
Carrier address lookup and WebSocket upgrades continue to use the original ingress request.

### Isolate Host development in its own Vite environment

Host development owns the dedicated `pluxel` environment. Application modules, dynamic plugins, and the development console share its runner, source conditions, singleton identities, semantic collector, and queued HMR. Default SSR and third-party `ssrLoadModule` retain Vite's own environment and are unaffected by Host module policy; custom SSR factories can coexist.

Vite resolves modules before the Host environment chooses native Node evaluation for CommonJS, native modules, and explicit singletons. Vite owns the runner and cleanup. Services scope database source transforms and transport externalization to the Host environment, and HTTP diagnostics preserve the runner's source maps without reprocessing them through another environment's graph.

Remove incidental public runner, classifier, and invalidation helpers from `@pluxel/host-dev/vite`. Use `host()` or the Services preset; combine `hostSingletons()` with that Host environment. The reserved `pluxel` environment factory cannot be replaced. Concrete source pipelines now bind their semantic collector to one named environment (default `ssr`). Legacy decorator syntax remains project-wide because Vite does not expose per-environment OXC options.

Initial Host and recovery failures now render their original stack, nested causes, and aggregate errors in Vite's terminal message, preserving the original Error for Vite's reporting bookkeeping.

Host and recovery diagnostics now share one internal structured logging entry that follows the current Host logger across replacement, falling back to the user's Vite logger before startup. It does not replace `customLogger` or install additional sinks.

### Share Host development reports and HTTP assembly

Host development publishes update history through Host status and Management, including retained
candidates, application compensation and lifecycle issues. Update outcomes include `failed` when
startup or compensation leaves no active Host. Failed cleanup preserves the original diagnostics
and does not skip remaining settlement or compensation.

Official application presets delegate HTTP and management ingress to their owning services. Plugin
scaffolding consistently declares Core and validation dependencies.

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

### Keep successful WebSocket upgrades out of shell fallbacks

Business WebSocket connections now complete their handshake when a host shell fallback is installed. A successful Elysia upgrade is treated as a handled request instead of falling through to the shell.

### Keep operation log cursors in the Logging domain

Add markLogs, readLogs and cancellable waitForLogs over existing bounded stores. JSON cursors retain
Host and stream identity; replacement, reset and retention gaps remain explicit failures. Waiting
releases its subscription on delivery, discontinuity or cancellation and never reconfigures logging.
Remove the unused internal Runtime launcher preinstallation bridge; Host owns logging preparation
and disposal through the ordinary logging service descriptor.

### Keep Plugin label projection independent of Host

Move the shared pure Plugin label functions to Core. Logging formatters and Management catalog projection now consume Core directly; Host no longer re-exports the implementation through its internal entry.

Remove manager creation, active-owner lookup, and Context binding functions from the Logging public root. Framework integrations retain the existing internal entry. Applications install `logging()` as a Host service and access the installed manager through `Logging` or `host.ctx.logging`.

### Consolidate Management integration entries

Remove unused and duplicate implementation-file exports, including the redundant `/endpoint` alias; use the package root for carrier endpoints. Official integrations now share `/internal` for portable presentation, `/internal/http` for HTTP assembly and `/internal/test` for cross-package white-box tests. Existing browser client, protocol, session and React imports use their public entries. Management-owned regression tests live with Management and no longer require published private implementation paths.

Management imports Cap’n Web, Logging wire types and Host fork/report operations directly from their owning packages, removing transparent forwarding modules and unused helpers. Config usecases use the existing wire result types directly. Workbench Shell asset constants move out of Management’s private presentation contract.

### Keep management sessions independent of Workbench installation

Management no longer imports Workbench types or declares it as an optional peer. Session bootstrap
types preserve the existing wire variants and expose an opaque RPC target by default. Shells that
consume Workbench methods bind the existing session client types to `WorkbenchSessionApi`; the
official Workbench app binds this once in its local runtime entry.

Server composition accepts the authenticated Management principal and a borrowed `{ target, dispose }`
session, without depending on Workbench's server implementation.

### Fix Workbench sessions behind Portless

Use the configured Portless browser origin for management WebSocket admission while preserving physical listener, TLS and peer-address facts.

### Resolve Node and Worker artifacts from the deployed application

`standardServices({ nodeModules })` forwards the existing Node artifact configuration. Generated
applications resolve `artifacts/node` from `startup.deployment.root`, so Node modules and Workers
continue to load when the frozen application moves or starts from a different working directory.
Development still attaches its source compiler separately.

### Make pure-data RPC contracts explicit

Management, Workbench and official Plugin RPC methods that return data or receipts now use `*Dto`.
This includes authentication `stateDto`/`submitDto`, session `logoutDto`, Workbench `layoutDto`,
Content `subscribeDto`/`loadDto`/`runDto`, and Plugin `snapshotDto` and data-returning mutations.
Void commands, capability acquisition, subscriptions returning handles, mixed bootstrap/open results,
local Plugin methods and local client facades retain their domain names. No previous RPC names remain
as aliases. Management protocol major is now 7 and the session profile is 2; clients and servers must
be deployed together.

Producers validate their DTO output with existing domain parsers or the new
`assertWorkbenchDto()` from `@pluxel/workbench/server`. The assertion checks bounded pure data without
copying, freezing, disposing or changing its identity; clients continue to validate and own received
values. Content subscription registration remains owned by its root even though `subscribeDto`
returns the initial data snapshot.

RPC targets keep internal lifecycle and implementation helpers off their remotely callable surface.
Author examples, UI consumers, tests and API documentation use the same contracts.

### Consume RPC values at their owning boundary

Workbench replaces `detachWorkbenchPortableValue()` and `WorkbenchDetached<T>` with
`consumeWorkbenchValue()` and `WorkbenchSnapshot<T>`. Queries, mutations and manual value reads
transfer ownership of their entire result tree. The boundary validates, removes transport metadata,
freezes the decoded tree in place and releases its transport result, without a second deep copy.
Local values must be owned or already immutable; callers must not pass borrowed mutable state or
separately dispose a consumed result. Null-prototype objects retain their prototype. Hidden data
properties and non-removable transport metadata are rejected.

Management clients consume transport envelopes before domain parsing. Domain parsers construct the
final immutable snapshot directly, avoiding an intermediate copied tree; opaque config, log and form
values remain independently copied. Portable values reject sparse arrays, extra array properties,
accessors and non-enumerable payload fields. Lifecycle, cache isolation and late-result disposal remain
owned by the existing session and renderer scopes.

### Ship optional service UI plugins from one package

Import `VaultAdminPlugin` from `@pluxel/services/plugins`. The separate `@pluxel/vault-admin`
package is retired before this release. Vault resources remain owned by the explicitly installed
service; the optional Plugin publishes the Workbench view and uses the authenticated Management
session. Starter and maintenance applications use the same public entry.

Concrete Plugins may be exported from explicit package subpaths. Their canonical identity contains
the package name, export path and named export. A constructor exported through multiple public
paths or names is rejected, as are cross-package Plugin re-exports. Package root identities remain
unchanged. Compilation, inspection, persistence and packaged Workbench artifacts share this contract.

### Use Host composition in tests and new applications

Add `@pluxel/services/test` with an isolated `createServiceTestHost()` backed by the production Host catalog, state, configuration and lifecycle. Explicit service lists replace the default HTTP, commands, Node artifacts, workers and memory persistence composition; Management is an opt-in test integration. The base test entry with `services: []` loads without optional HTTP or Workbench peers; the default HTTP composition explicitly requires Elysia. `@pluxel/workbench/test` owns `createWorkbenchTestHost()`. `@pluxel/workbench/server` exposes typed `openLocalWorkbenchEntry()` for local sessions with caller-owned disposal and cancellation. Core author symbols remain in `@pluxel/core/test`.

Generated applications use Host environment settings and the service presets without a Runtime package dependency.

The published starter derives its first-party catalog ranges from the current package manifests during the create build, so Tegami version changes cannot leave newly generated applications on stale framework ranges.

### Return Command Result from runtime services

Root catalog and carrier mount execution now return `Result<T, CommandFailure>`.
Owner admission, withdrawal, and execution faults have explicit failure branches, while
completed command receipts remain intact. Management commands define recoverable missing
plugins as `REJECTED` and retain lifecycle failures as `DEPENDENCY`.
Unreadable trusted command contexts settle as `INTERNAL` with the original local cause.

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

### Preserve srvx native client cancellation

Node listeners use srvx request cancellation directly instead of installing a second disconnect listener. Handlers retain the original transport abort reason, including socket errors such as `ECONNRESET`; cancellation is identified by `request.signal.aborted`, not a fixed error name. Owner shutdown cancellation and request address mapping remain intact.

### Reject invalid explicit configuration

The official services preset now rejects unknown top-level options and a non-boolean Workbench selection. The CLI rejects an empty `PLUXEL_STATE_DIR` instead of silently using the default directory.

### Validate packaged Shell assets and preserve static IO failures

Shell builds now verify the declared entry, complete manifest references and files in the selected package layout. Invalid manifests fail instead of selecting another entry. Static file IO errors return HTTP 500 with server-side diagnostics; missing files remain 404 or eligible SPA navigation fallbacks.

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

### Vault uses only the current storage contract

Remove `legacyNamespaces` and startup namespace migration. Encrypted snapshots require version 2 with per-record revisions; unversioned documents are no longer converted.

### Separate management transport from the Workbench Shell

`workbenchHttp()` now owns only the Shell fallback. Compose `managementHttp({ bindings })`
explicitly for authenticated sessions and artifacts, declaring the `WorkbenchHost` preparation
dependency exported from `@pluxel/workbench/server`. The official services preset performs this
composition and keeps management HTTP/WebSocket access when Workbench is disabled.

Add `workbenchSourceShell({ entry })` to the existing development entry for explicit source Shell
serving through the current Vite server. Application frontend transforms remain application-owned.
The Shell service loads packaged assets on its first static request, allowing source development
without a prebuilt UI; the standalone packaged handler still validates assets when created.

HTTP mount factories expose the Host service contract without publishing their internal HTTP carrier dependency types, so importing their declarations does not pull Elysia into unrelated consumer type checking.

Shell HTML escapes all asset URL attributes, preserving source paths that contain HTML entities
and preventing URL punctuation from being interpreted as markup.

### Share the Workbench RpcTarget in development

Resolve source publishers' Cap’n Web imports from the selected Workbench installation, so linked workspaces with separate copies can open Views without losing native RpcTarget identity.

### Admit shared Workbench Cap'n Web before connecting module identity

Workbench now declares `capnweb` as a peer, while final Host applications provide the runtime directly. Development, static application builds, and production dynamic sources check a target publisher's peer and actual installed version before connecting its import to the Host Workbench module. A base library that supplies a Workbench target class is checked by its peer declaration even when it has no generated publication marker. Independent private RPC packages keep their own resolution. Source builds also require a matching development copy; installed publishers only require their published peer and installed runtime.
