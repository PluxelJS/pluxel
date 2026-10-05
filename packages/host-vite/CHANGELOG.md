## @pluxel/host-dev@1.1.0

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

### Show application readiness in dev discovery

`pluxel dev instances` now reports whether the live Vite console has a ready Host, is applying an update, or has no admitted Host. The existing recent update snapshot remains visible when initial admission fails.

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

### Align development console polymorphism with test hosts

Add dependency inspection and default/consumer provider selection, persistent fork creation and removal, and synchronous running-state queries to the development console. Abstract requirements and typed fork targets use the existing identity and lifecycle rules; mutations return production domain results and application reports.

### Preserve Vite source resolution and browser diagnostics

Enable Vite tsconfig path resolution by default while respecting an explicit `false`. Classify
alias-resolved CommonJS files through the same Node execution boundary as installed dependencies.
Report browser imports of Node builtins immediately with their importer, while allowing explicit
browser implementations and leaving server imports unchanged.
Normalize Vite filesystem IDs consistently for recovery and host module classification, including
Windows drive paths, duplicate POSIX slashes, and query/hash suffixes.

Remove the unused Host-dev `hmr-log` entry and root log-schema exports. Application update reports
and plugin lifecycle reports remain the authoritative development diagnostics.

### Restore HMR after installing a missing package

Keep recovery watches active when package resolution searches overlapping ancestor directories, so installing a previously missing dependency automatically retries the failed application update.

### Recover failed candidates without mixing runtime and Workbench generations

Prepare Workbench artifacts before catalog acceptance and activate them at the graph commit boundary. Rejected candidates preserve the running generation's Content and producer builds; superseded background validations cannot publish.

Host Vite retains failed-candidate recovery dependencies independently of the committed graph, including new files, missing imports and package installation metadata. Fixing those dependencies automatically retries the candidate and restores dependent plugins.

Management clients can read and subscribe to independent update attempts. Workbench displays batch progress and bounded failure details in its header, preserving the distinction between rejected updates and current plugin health. Revoked Workbench sessions automatically reload the document after cleanup, with a bounded retry interval and manual fallback for repeated refreshes or authentication failures.

### Report rejected HMR candidates through the Host logger

Host development now reports errors from Vite hot-update handling through its existing structured diagnostics before propagating the original error to Vite. Semantic rejection retains the previous accepted artifact; failures while building an accepted producer plan continue to expose the Workbench producer failure state.

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

### Keep candidate orchestration inside the development host

Stop exporting candidate creation, invalidation, source evaluation and recovery implementation helpers
from `/vite`. Custom service attachments use `HostDevelopmentPluginApi`; the Host remains responsible
for admitting, committing and settling candidates.

### Consolidate Host application and development integration entries

Import `runHostApplication` from `@pluxel/host`, alongside the existing application contracts.
Remove the duplicate `/application` entry and update generated production launchers.

Host-dev exposes one explicit `/internal` entry for framework integration. Console execution,
IPC protocol, server and attachment implementations are private, with package-local tests
importing their source directly. The public console and Vite entries remain separate.

Portable execution snapshots and their validators now cross the browser/server boundary through `@pluxel/host/internal/protocol`. Management clients use this dependency-free entry instead of the server integration barrel; the duplicate execution exports and Management forwarding module are removed. Browser builds no longer traverse Host source loading and Node built-ins to validate update reports.

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

### Share framework identities with the application

Declare Core, Host and shared service/management contracts as peer dependencies with local
development copies. The compiler likewise consumes the application's Core lowering ABI.
Workbench declares React, Mantine and React Bridge as shared platform peers; owned implementation
libraries remain normal dependencies. This prevents integrations from silently installing their own
framework identities and makes compatible application dependencies explicit.

### Reject incomplete workspace and package discovery

Workspace membership now comes from `pnpm-workspace.yaml`. Malformed selected manifests, invalid patterns, and scan IO failures stop discovery instead of silently dropping candidates. Host module classification stops at a broken package manifest, and OXC initialization and thrown resolution failures retain their causes.

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

### Refresh supported tooling and generated projects

Update runtime, rendering, validation and tooling dependencies together across the published packages and generated projects.
New projects use Elysia 2 beta.19 and TypeScript 7, with TypeBox 1.3.23 pinned for Elysia eager schema compilation.
Update fixture dependencies while retaining the tested VFS release until its newer release restores trusted-publisher evidence.

Read extracted HTML CSS through Takumi’s current `css` result field, avoiding its deprecated alias and per-process warning.

### Recover Workbench definition hot updates across edits, failures and file replacement

Refresh standalone Workbench definitions and imported helpers within the same semantic generation as Plugin facts. Reject superseded transforms, discard failed parsing work, withdraw deleted publications, and preserve committed facts when a candidate is rejected. Generated Bridge and renderer projection files now use revision-specific paths.

Host Vite development handles file creation and deletion through the same update queue as edits, allowing recreated definitions and their dependent plugins to recover without restarting dev.
