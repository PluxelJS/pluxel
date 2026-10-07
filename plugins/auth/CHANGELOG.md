## @pluxel/auth@2.0.0

### Native modules delivery and owned Vite execution

Replace Host dynamic source execution with pure `@pluxel/host/sources` declarations. Native startup accepts a precompiled application module path and binds shared packages before evaluating its factory and fixed imports, then scans sources once, validates shared package versions and loaded artifact inventories, and reports next-start consumption. `createHost()` accepts evaluated Plugins only.

Rename Host Dev to `@pluxel/host-vite`. Its root configures the same update driver for development and production; `/run` owns production startup and close, while `/console` remains development-only. Execution diagnostics explicitly distinguish native/Vite, fixed/source, artifact and update behavior. Workbench runtime artifact attachments move to `/vite`.

Execution and build options are captured at owner creation. Source admission consistently rejects linked entry leaves with a located error. Host-vite observes rapid file repairs and drains accepted watcher work; production close releases remaining resources after failures and preserves its rejection on repeated calls. Artifact candidate commit and rollback are synchronous contracts checked for JavaScript callers too.

Development startup distinguishes the workspace used by CLI doctor from the member package that declares the CLI. It preserves explicit configuration roots and project installation boundaries, and reports invalid setup through the existing doctor.

Add modules application delivery with an exported factory/product, unique compiled public exports, unchanged canonical identities and verified Node/Workbench inventories. Standalone remains the default fixed-catalog build. Generated hosts use modules with native startup and an independent production Vite example; CLI resources and documentation follow these contracts. Removed entry points and fields have no aliases.

Standalone delivery preserves traced native libraries in the `@pluxel` namespace through explicit residual selection; Core/Host identities remain bundled and traced duplicate framework copies are rejected. Native startup reuses successful namespace admission within its loader and stores cached entry closures as shared immutable prefix views. Vite validates its completed initial source observation once, while live updates and source consumers retain current validation.

Official published Plugins declare their artifact root and Node/Workbench inventory capabilities so installed consumers validate the compiled artifacts owned by the actual loaded package.

Standalone Workbench builds select producer and Content owners from the validated fixed catalog using the existing compiler's constructor bindings. Unselected definitions do not read renderer/Markdown inputs, build UI, or copy package artifact trees; selected inventories retain strict validation.

## @pluxel/auth@1.1.0

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

### Preserve unexpected credential hashing failures

Credential setup returns expected input and hashing-capacity failures through its existing DTO codes.
Unexpected crypto failures now reject with a safe diagnostic message instead of claiming the password
is invalid; credentials are neither persisted nor applied. The setup RPC boundary strips diagnostic
causes from unexpected mutation rejections while preserving the existing expected-failure DTOs.
Plugin author guidance and executable
official-plugin examples explain selective Better Result adaptation and transport/resource boundaries.

### Add bounded third party version contracts

Add the optional `@pluxel/core/better-result` entry with all named exports from the shared `better-result` dependency.
Check the exact `capnweb` peer, development and installed versions when a plugin package publishes a
Workbench View or Attachment target. Move Vault Admin's `capnweb` to a peer and development dependency.
Record target publication in package metadata so static builds and dynamic source loaders share the
host `RpcTarget` constructor only for those publishers. Diagnose deployment version mismatches before
target evaluation. Improve the Workbench identity diagnostic and use Result within Auth credential
preparation while preserving its portable setup replies.

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

## @pluxel/auth@1.0.0

### Initial open-source release

Publish the supported Pluxel packages together at 1.0.0. Current package contracts and development workflows are documented in the repository.
