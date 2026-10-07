## @pluxel/cli@2.0.0

### Bind development packages, documentation and skills to one source

Git CLI setup uses its owning checkout instead of a global Pluxel override, manages ignored docs/skill links and records workspace setup. CLI releases include offline development resources; `workspace setup` materializes them and `docs` reads their contents. Development hosts check project setup before startup. Generated project instructions describe the unified setup flow.

### Native modules delivery and owned Vite execution

Replace Host dynamic source execution with pure `@pluxel/host/sources` declarations. Native startup accepts a precompiled application module path and binds shared packages before evaluating its factory and fixed imports, then scans sources once, validates shared package versions and loaded artifact inventories, and reports next-start consumption. `createHost()` accepts evaluated Plugins only.

Rename Host Dev to `@pluxel/host-vite`. Its root configures the same update driver for development and production; `/run` owns production startup and close, while `/console` remains development-only. Execution diagnostics explicitly distinguish native/Vite, fixed/source, artifact and update behavior. Workbench runtime artifact attachments move to `/vite`.

Execution and build options are captured at owner creation. Source admission consistently rejects linked entry leaves with a located error. Host-vite observes rapid file repairs and drains accepted watcher work; production close releases remaining resources after failures and preserves its rejection on repeated calls. Artifact candidate commit and rollback are synchronous contracts checked for JavaScript callers too.

Development startup distinguishes the workspace used by CLI doctor from the member package that declares the CLI. It preserves explicit configuration roots and project installation boundaries, and reports invalid setup through the existing doctor.

Add modules application delivery with an exported factory/product, unique compiled public exports, unchanged canonical identities and verified Node/Workbench inventories. Standalone remains the default fixed-catalog build. Generated hosts use modules with native startup and an independent production Vite example; CLI resources and documentation follow these contracts. Removed entry points and fields have no aliases.

Standalone delivery preserves traced native libraries in the `@pluxel` namespace through explicit residual selection; Core/Host identities remain bundled and traced duplicate framework copies are rejected. Native startup reuses successful namespace admission within its loader and stores cached entry closures as shared immutable prefix views. Vite validates its completed initial source observation once, while live updates and source consumers retain current validation.

Official published Plugins declare their artifact root and Node/Workbench inventory capabilities so installed consumers validate the compiled artifacts owned by the actual loaded package.

Standalone Workbench builds select producer and Content owners from the validated fixed catalog using the existing compiler's constructor bindings. Unselected definitions do not read renderer/Markdown inputs, build UI, or copy package artifact trees; selected inventories retain strict validation.

## @pluxel/cli@1.1.0

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

### Require package-scoped source links

Source overlays require repository directories containing package symlinks. Remove automatic conversion of whole-checkout symlinks; unexpected paths are rejected without replacement.

### Show application readiness in dev discovery

`pluxel dev instances` now reports whether the live Vite console has a ready Host, is applying an update, or has no admitted Host. The existing recent update snapshot remains visible when initial admission fails.

### Make filesystem fixture contracts truthful

Use `fixture.fsp` for Promise file operations. `fixture.fs` exposes callback, synchronous and stream
operations without inheriting conflicting Promise signatures. Missing callbacks now fail explicitly.
Memory fixtures reject `fs/tempDir` overrides; disk fixtures accept `tempDir` but always own native fs.

### Keep process-owned build orchestration inside the official CLI

`runWithTsdown` is no longer exported from the public `/build` entry. Official CLI cooperation uses
an explicit `/internal/cli` allowlist. Custom build hosts use the public `pluginPackage` preset.
The CLI runner owns one-shot bundle cleanup, including hook failures; watch resources, configuration
restarts and terminal interaction remain owned by the command process.

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

### Reject invalid explicit configuration

The official services preset now rejects unknown top-level options and a non-boolean Workbench selection. The CLI rejects an empty `PLUXEL_STATE_DIR` instead of silently using the default directory.

### Reject incomplete workspace and package discovery

Workspace membership now comes from `pnpm-workspace.yaml`. Malformed selected manifests, invalid patterns, and scan IO failures stop discovery instead of silently dropping candidates. Host module classification stops at a broken package manifest, and OXC initialization and thrown resolution failures retain their causes.

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

## @pluxel/cli@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
