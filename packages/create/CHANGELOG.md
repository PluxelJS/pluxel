## @pluxel/create@2.0.0

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

### Consolidate service domains and application composition

Management, Logging and official presets now belong to Services, retaining separate source domains and browser/server entry points. Use @pluxel/services/management, /logging, /preset, /vite, /build and /test instead of separate package installations. The Workbench Shell belongs to Workbench rather than a separate private workspace. Package-level mutual references are permitted across isolated leaf entries; module initialization and resource ownership remain explicit.

### Resolve Node and Worker artifacts from the deployed application

`standardServices({ nodeModules })` forwards the existing Node artifact configuration. Generated
applications resolve `artifacts/node` from `startup.deployment.root`, so Node modules and Workers
continue to load when the frozen application moves or starts from a different working directory.
Development still attaches its source compiler separately.

### Use Host composition in tests and new applications

Add `@pluxel/services/test` with an isolated `createServiceTestHost()` backed by the production Host catalog, state, configuration and lifecycle. Explicit service lists replace the default HTTP, commands, Node artifacts, workers and memory persistence composition; Management is an opt-in test integration. The base test entry with `services: []` loads without optional HTTP or Workbench peers; the default HTTP composition explicitly requires Elysia. `@pluxel/workbench/test` owns `createWorkbenchTestHost()`. `@pluxel/workbench/server` exposes typed `openLocalWorkbenchEntry()` for local sessions with caller-owned disposal and cancellation. Core author symbols remain in `@pluxel/core/test`.

Generated applications use Host environment settings and the service presets without a Runtime package dependency.

The published starter derives its first-party catalog ranges from the current package manifests during the create build, so Tegami version changes cannot leave newly generated applications on stale framework ranges.

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

## @pluxel/create@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
