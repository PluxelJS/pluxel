## @pluxel/workbench@1.2.0

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

### Build production Workbench artifacts from the source package graph

Compile Plugin and application Workbench producers with explicit source exports and production conditions, including shared export inspection and required dynamic types. Cold workspace builds no longer require prebuilt Workbench artifacts. Distribution assembly continues to require built package exports without falling back to source.

Update the Oxc parser dependency to 0.153 and validate the build with the refreshed Vite, Rolldown, and TypeScript toolchain.

Bundle the Workbench-owned pure transport admission rules into the toolchain and locate its capnweb dependency through the package manifest. Publication metadata validation no longer loads the Workbench runtime build.

Update the exact Workbench federation compatibility profile to Module Federation Vite 1.23.3 and Runtime, SDK, and React Bridge 2.9.2. Rebuild producer artifacts with the updated profile. Keep the full shared export surface adaptation for Mantine producers.

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

### Refresh shared external dependency ranges

Upgrade the shared runtime and tooling catalogs and use caret ranges for compatible stable releases. Align source consumers through the bundled pncat policy, including Elysia 2 beta.26 and current TypeBox. Preserve explicit prerelease, native pairing, patched dependency, and public peer compatibility exceptions.

Rebuild Workbench producer artifacts against the Mantine 9.7.1 compatibility set; the Shell and remote producers continue to require identical shared UI versions.

Generate starter catalogs through pncat using the same core version policy and Tegami package versions.

Handle declared optional dependencies whose platform packages are not installed, including dangling package-manager links, while keeping actual source imports strictly validated.

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

### Consolidate Management integration entries

Remove unused and duplicate implementation-file exports, including the redundant `/endpoint` alias; use the package root for carrier endpoints. Official integrations now share `/internal` for portable presentation, `/internal/http` for HTTP assembly and `/internal/test` for cross-package white-box tests. Existing browser client, protocol, session and React imports use their public entries. Management-owned regression tests live with Management and no longer require published private implementation paths.

Management imports Cap’n Web, Logging wire types and Host fork/report operations directly from their owning packages, removing transparent forwarding modules and unused helpers. Config usecases use the existing wire result types directly. Workbench Shell asset constants move out of Management’s private presentation contract.

### Native modules delivery and owned Vite execution

Replace Host dynamic source execution with pure `@pluxel/host/sources` declarations. Native startup accepts a precompiled application module path and binds shared packages before evaluating its factory and fixed imports, then scans sources once, validates shared package versions and loaded artifact inventories, and reports next-start consumption. `createHost()` accepts evaluated Plugins only.

Rename Host Dev to `@pluxel/host-vite`. Its root configures the same update driver for development and production; `/run` owns production startup and close, while `/console` remains development-only. Execution diagnostics explicitly distinguish native/Vite, fixed/source, artifact and update behavior. Workbench runtime artifact attachments move to `/vite`.

Execution and build options are captured at owner creation. Source admission consistently rejects linked entry leaves with a located error. Host-vite observes rapid file repairs and drains accepted watcher work; production close releases remaining resources after failures and preserves its rejection on repeated calls. Artifact candidate commit and rollback are synchronous contracts checked for JavaScript callers too.

Development startup distinguishes the workspace used by CLI doctor from the member package that declares the CLI. It preserves explicit configuration roots and project installation boundaries, and reports invalid setup through the existing doctor.

Add modules application delivery with an exported factory/product, unique compiled public exports, unchanged canonical identities and verified Node/Workbench inventories. Standalone remains the default fixed-catalog build. Generated hosts use modules with native startup and an independent production Vite example; CLI resources and documentation follow these contracts. Removed entry points and fields have no aliases.

Standalone delivery preserves traced native libraries in the `@pluxel` namespace through explicit residual selection; Core/Host identities remain bundled and traced duplicate framework copies are rejected. Native startup reuses successful namespace admission within its loader and stores cached entry closures as shared immutable prefix views. Vite validates its completed initial source observation once, while live updates and source consumers retain current validation.

Official published Plugins declare their artifact root and Node/Workbench inventory capabilities so installed consumers validate the compiled artifacts owned by the actual loaded package.

Standalone Workbench builds select producer and Content owners from the validated fixed catalog using the existing compiler's constructor bindings. Unselected definitions do not read renderer/Markdown inputs, build UI, or copy package artifact trees; selected inventories retain strict validation.

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

### Add bounded third party version contracts

Add the optional `@pluxel/core/better-result` entry with all named exports from the shared `better-result` dependency.
Check the exact `capnweb` peer, development and installed versions when a plugin package publishes a
Workbench View or Attachment target. Move Vault Admin's `capnweb` to a peer and development dependency.
Record target publication in package metadata so static builds and dynamic source loaders share the
host `RpcTarget` constructor only for those publishers. Diagnose deployment version mismatches before
target evaluation. Improve the Workbench identity diagnostic and use Result within Auth credential
preparation while preserving its portable setup replies.

### Decouple public origins from the development proxy

Replace the Portless-specific environment contract with `hostEnv.publicOrigin`:
`PLUXEL_PUBLIC_ORIGIN` explicitly configures any reverse proxy, with automatic discovery
from Pitchfork's `PITCHFORK_URL`. Listener settings independently accept `HOST` and
`PORT` beneath explicit Pluxel overrides, including when no proxy is enabled.
Vite URL output and Vite/native management same-origin validation share this trusted startup
origin while carrier URLs retain the physical listener address.

### Refresh the Workbench Federation profile

Use Module Federation Vite 1.22.1 with Runtime, SDK and React Bridge 2.9.1 and Mantine 9.6.3. The exact producer and Shell compatibility checks remain enforced; rebuild renderer artifacts with the updated profile.

Keep shared-surface import analysis, application-root scheduling and isolated declaration caches: real Mantine producer builds and upstream shared state still require these boundaries with the updated plugin.

### Align the official Pluxel release line

Release the public framework packages and official Plugins together at 1.2.0. This is the maintainer's explicit version choice for the currently unpublished release; existing breaking-change descriptions remain part of the release notes. Future releases retain semver-based group bumps, and newly introduced pre-1.0 packages join the current release line.

Independent official Plugin packages use `@pluxel/plugin-*`. Update dependency names, package imports, subpath imports and application declarations together. This naming change preserves Plugin class names, exports and constructor declarations. Core, Host, Services, Workbench and tooling packages retain their existing names. Private Plugins remain workspace-only.

A Plugin's canonical identity includes its package entry. Rebuild consumer artifacts and explicitly review saved configuration, startup intent and Workbench state keyed by the previous identity before deployment; no old-name alias or automatic runtime migration is installed.

Carry forward the unpublished release notes. Earlier Host Dev notes belong to Host-vite; the former Typst Markdown extension belongs to the consolidated Markdown package. Their original explanatory bodies remain available alongside the later migration notes.

### Use native Cap’n Web ownership in isolated RPC tests

Remove `createLocalRpcClient()` from `@pluxel/workbench/test` and its borrowed-target proxy.
Pure RPC tests use `new RpcStub(new Target())` from `capnweb`, with the library's native
reference disposal semantics. Workbench testing types continue to describe Workbench entries and leases.

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

### Compile source consumers with either optional-property mode

Narrow optional addresses and federation references by their values so source consumers and generated Workbench declarations also compile without `exactOptionalPropertyTypes`. Omit unspecified picklist labels from the portable presentation data while preserving supplied labels.

### Validate packaged Shell assets and preserve static IO failures

Shell builds now verify the declared entry, complete manifest references and files in the selected package layout. Invalid manifests fail instead of selecting another entry. Static file IO errors return HTTP 500 with server-side diagnostics; missing files remain 404 or eligible SPA navigation fallbacks.

### Acquire remote values only after React commit

`useRemoteValue` no longer starts reads or subscriptions during render. StrictMode replay shares
one owner; dependency changes isolate reads and late subscriptions are released after unmount.
The imperative `createRemoteValue` retains eager acquisition and explicit disposal.

### Type AutoForm options against input drafts

Schema forms now infer Valibot input values instead of transformed outputs. Both form modes
accept typed TanStack options and infer submit callbacks. `submit()` returns its completion
Promise and propagates callback rejection; DOM-submit callbacks remain responsible for displaying failures.

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

### Improve plugin document titles and catalog interactions

Name loaded configuration tabs after their plugin. Replace large name-hover diagnostic cards with concise names, delay catalog hints and suppress them during scrolling. Distinguish selected and unselected controls, support Shift range selection through selection buttons, and remove redundant double-click activation.

Keep collapsed rows outside keyboard selection ranges and select-all. Preserve custom document titles during detail refresh, restore and duplication; remove obsolete navigation modes.

### Fix configuration document sizing and spacing

Stretch configuration documents across their native tab container. Put the configuration outline in a collapsible section before the form instead of appending it below the fields. Remove redundant padding and overrides of Mantine control dimensions. Stack log policy fields in the narrow plugin inspector.

### Keep fresh React installs compatible with precompiled Workbench artifacts

Pin React and ReactDOM installation and peer declarations to the same exact stable version used by the precompiled Workbench producers. Generated starters inherit these exact versions, so a fresh installation cannot select a newer patch that the published Federation manifest rejects. Applications consuming these artifacts must use the declared exact versions; upgrading the shared runtime requires rebuilding the corresponding assets.

### Correlate Workbench factory failures

Workbench open failures now distinguish invalid and reused targets from arbitrary factory exceptions. Factory failures expose a diagnostic id linked to the server log, without sending exception details to the browser.

### Restore native tool borders

Use native left, right and bottom Borders, with native click-to-collapse behavior and recovery strips. Bottom is empty by default and appears only for the active plugin's declared extensions. Remove central bottom height emulation. Keep document docking in the center and scope tool availability to the active plugin. Use layout storage revision 7 for independent native panel tabs; plugin groups and business settings are unchanged.

### Separate official tools from plugin panels

Keep official plugin information and recent logs inside the fixed official tool. Open declared plugin panels as independent, closable native tabs, reorderable within their declared region. Discover and reopen them through the official extension directory or entry search. Preserve each owner’s unclosed panel layout across context switches and reload, without automatically reopening closed panels or persisting live renderer resources.

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

### Fix packaged Shell lazy assets

Build lazy imports and preload URLs under the Workbench asset mount instead of the application root.

### Preview plugin logs and open scoped log documents

Show up to ten recent plugin log entries in a dedicated inspector tab, with a fixed header and full-page link above independently scrolling records. Open complete logs in an independent document with an exact plugin/fork URL filter, preserved on refresh and independently clearable. Keep logging policy beside the preview and scoped log page; remove the unused detail-card presentation.

Compose preview and full log documents from a shared bounded stream reader and log row, list, and detail components. Replace permanent filter/detail columns with an applied URL filter popover and on-demand details. Fence stale reads across reset, clear, and disposal, preserve ordered gap recovery, and prevent stale policy queries from overwriting writes.

### Preserve the matched Plugin route during navigation

Read Plugin page paths from their accepted route context. Navigating to another page while its loader is pending keeps the current Plugin page visible without reporting an invalid route from the destination URL.

### Adopt the native FlexLayout workspace

Use one Worksplit instance and one native FlexLayout Model for document tabs, TabSets, TabGroups, Borders, pinning, dragging and maximization. Each document owns its TanStack memory Router; Worksplit alone coordinates workspace browser history. Plugin pages open as independent documents, preserving canonical publication identity, authentication, RPC and per-open resource ownership.

Replace the workspace grid, duplicated tab state and fixed plugin panel topology with native docking and Mantine themed native menus. Persist the Worksplit snapshot under a new storage key; previous workspace layouts are not restored, and invalid snapshots require an explicit retry or reset. Business drafts remain owned by their documents and are not included in layout persistence.

Remove the unused `WorkbenchPane`, `WorkbenchPaneLayout`, `useWorkbenchPaneLayout`, associated types and Federation Pane renderer bridge fields. Renderers use ordinary CSS/Mantine for local content layout and publication entries for independently dockable pages.

Resolve hosted navigation frames from committed publication, including short standalone routes and canonical conflict URLs. Keep the actual UI basepath and structured search/hash when opening Shell documents, and apply requested document titles and metadata to native tab names and hover help.

Derive new Plugin document names from the complete committed publication: a tab label or entry key, the Plugin display name, or the exact owner's compiled route title. Keep the native tab name across reactivation, view query/hash changes and snapshot refresh, including F2 names for active and lazy documents. Apply a new route default only when the actual document identity changes. Tab-context copies append “（副本）” to the current native name and retain independent drafts, while copies opened from navigation use the entry default.

### Browse within the active tab and duplicate explicitly

Use the active document router for ordinary navigation, preserving its native leave guards and history. The active tab's plus button opens an independent copy of its current URL immediately after it. Global search remains navigation; explicit plugin openDocument requests continue to create separate documents. Copies do not clone unsaved editor state.

Place the active tab's plus control after its visible tab boundary, with separate space from the title and close control.

Keep the browser URL synchronized with accepted query-only navigation when focus changes inside the active document, including clearing a plugin log filter.

### Restore direct navigation and contextual plugin tools

Restore an official activity rail with icons by default and an optional text mode. Separate business applications at `/apps` from plugin management at `/plugins`. The management workspace shows its plugin directory; business application sidebars show only the current owner's contributed panels and take no space when no left panel exists. Hide the redundant native border strip when navigation is its only tab, and show it again when documents are docked there. Application discovery respects explicit route navigation declarations and highlights the exact active entry.

Use each tab container's `+` action to choose an entry and create an independent document. Ordinary navigation reuses an existing document, and entry lists no longer show a separate duplicate button for every item. Global search remains available for discovery.

Use compact single-line navigation with status dots, explicit problem labels, collapsible counted groups, and search that reveals matches without overwriting collapse preferences. Keep search and management on one row, and collapse the default sidebar on narrow screens.

Keep configuration and plugin pages in the document area, with plugin information initially hidden on the right. Open plugin-scoped logs on demand in a native TabSet below the central documents, without spanning the sidebars. The header toggle hides logs while preserving their native node and return position; showing logs restores that position when available. Explicitly closing the log tab removes only that tool. Both tools follow the active document's canonical plugin, including forks and declared page owners. Hidden tools release their reads and log subscriptions, including when another container is maximized, without discarding document drafts.

Center independent left, right and bottom visibility controls in the header and restore the selected tool when showing a sidebar again. Persist the activity rail display mode with the native layout. Use layout storage version 4 and start from the new default layout instead of restoring older layouts; unsaved drafts are not migrated.

Add `workbench.panel(region, { label, icon?, order? })` for Content, View and placed Attachment contributions to the active plugin’s left, right or bottom tools. Panels have plugin-owner context, not the active document’s entity or route parameters. Entity editing and unsaved configuration remain in independent central documents. Panels share existing publication admission and per-open cleanup, switch without changing the document URL, and release resources when hidden or when the plugin changes. The ReportStudio example demonstrates static guidance and live status/artifact panels through existing domain snapshots and subscriptions.

### Prefer declared Workbench route paths and diagnose collisions

Workbench exposes all committed routes in its global layout, including parameterized routes and pages outside navigation. The Shell uses declared paths below its UI base URL when unambiguous. Overlapping routes from different plugin instances and reserved Shell paths use canonical plugin URLs with visible collision diagnostics. Canonical URLs remain available, and aliases are recomputed after publication changes.

### Admit shared Workbench Cap'n Web before connecting module identity

Workbench now declares `capnweb` as a peer, while final Host applications provide the runtime directly. Development, static application builds, and production dynamic sources check a target publisher's peer and actual installed version before connecting its import to the Host Workbench module. A base library that supplies a Workbench target class is checked by its peer declaration even when it has no generated publication marker. Independent private RPC packages keep their own resolution. Source builds also require a matching development copy; installed publishers only require their published peer and installed runtime.

### Improve Workbench sidebar scrolling and document navigation

The built-in Workbench overview scrolls independently with fixed tabs. Configuration and Markdown headings appear in a separate searchable outline tab even when the editor does not overflow. Outline tracking scrolls only its own list, uses the available sidebar height, and follows the active editor. Sidebar tab switches retain mounted scroll positions.

### Use one grouped plugin catalog in the sidebar

Reuse the existing plugin organizer as the management sidebar, preserving persisted groups, ordering, drag-and-drop, multi-selection, status filters and bulk actions. Highlight the active plugin and remove the duplicate central catalog. Reduce group card decoration for the narrow sidebar.

### Keep the last tab when removing it from a group

Apply Worksplit's existing FlexLayout fix in the framework workspace so the built
Shell preserves the document and its container when the last grouped tab is ungrouped.

### Stop snapshot writes after workspace disposal

Flush the final workspace snapshot when its storage closes, then reject delayed
persistence scheduling and retries. Disposed workspaces can no longer overwrite
the saved state of a subsequently opened workspace.

### Clarify workspace reading surfaces

Separate workspace chrome, document surfaces and existing summary cards with neutral tones and clearer boundaries in both color schemes. Preserve compact rows, default control sizing and flat content structure without additional nested cards or decorative shadows.

Use shared, visibly distinct active, inactive-selected and hover fills for workspace tabs, navigation and selection. Preserve selected backgrounds on hover and independent keyboard focus outlines.

### Keep implementation modules private

Remove unused Workbench `/paths`, `/internal/shell` and `/internal/definition` exports and the unused
Rolldown `/internal/static-config-environment-vite` adapter. Package-local white-box tests import
source modules directly. The generated browser React Bridge ABI remains isolated at
`@pluxel/workbench/internal/react`.

Workbench owner publication now captures the owner directly in the frozen `publish()` capability, removing the intermediate `WorkbenchService` wrapper while preserving PluginPart rejection and backend admission. Remove the unused `createWorkbenchBackend` factory and `WorkbenchBackendFactory` type; custom internal test assembly still injects a backend through the shared service installation path. Shell asset paths are owned locally by Workbench.

### Fill the available Workbench space for federated pages

Give federated View and Attachment renderers a sized mount container. Pages now fill their editor pane instead of shrinking to their content width, and Pane Kit responds to the actual available width when choosing columns or drawers.

### Simplify latest-state RPC subscriptions

Add `createWorkbenchWatch()` to `@pluxel/workbench/server`. Plugin targets connect a local
revision subscription to a remote observer without implementing a separate subscription target.
The helper owns callback references, invocation results and local registration cleanup, closes on
open abort or observer failure, and bounds notification work to one in-flight callback and the latest
pending revision. It is intended for snapshot invalidation, not lossless event delivery.

## @pluxel/workbench@1.1.0

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

### Consolidate Management integration entries

Remove unused and duplicate implementation-file exports, including the redundant `/endpoint` alias; use the package root for carrier endpoints. Official integrations now share `/internal` for portable presentation, `/internal/http` for HTTP assembly and `/internal/test` for cross-package white-box tests. Existing browser client, protocol, session and React imports use their public entries. Management-owned regression tests live with Management and no longer require published private implementation paths.

Management imports Cap’n Web, Logging wire types and Host fork/report operations directly from their owning packages, removing transparent forwarding modules and unused helpers. Config usecases use the existing wire result types directly. Workbench Shell asset constants move out of Management’s private presentation contract.

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

### Use native Cap’n Web ownership in isolated RPC tests

Remove `createLocalRpcClient()` from `@pluxel/workbench/test` and its borrowed-target proxy.
Pure RPC tests use `new RpcStub(new Target())` from `capnweb`, with the library's native
reference disposal semantics. Workbench testing types continue to describe Workbench entries and leases.

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

### Validate packaged Shell assets and preserve static IO failures

Shell builds now verify the declared entry, complete manifest references and files in the selected package layout. Invalid manifests fail instead of selecting another entry. Static file IO errors return HTTP 500 with server-side diagnostics; missing files remain 404 or eligible SPA navigation fallbacks.

### Acquire remote values only after React commit

`useRemoteValue` no longer starts reads or subscriptions during render. StrictMode replay shares
one owner; dependency changes isolate reads and late subscriptions are released after unmount.
The imperative `createRemoteValue` retains eager acquisition and explicit disposal.

### Type AutoForm options against input drafts

Schema forms now infer Valibot input values instead of transformed outputs. Both form modes
accept typed TanStack options and infer submit callbacks. `submit()` returns its completion
Promise and propagates callback rejection; DOM-submit callbacks remain responsible for displaying failures.

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

### Correlate Workbench factory failures

Workbench open failures now distinguish invalid and reused targets from arbitrary factory exceptions. Factory failures expose a diagnostic id linked to the server log, without sending exception details to the browser.

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

### Fix packaged Shell lazy assets

Build lazy imports and preload URLs under the Workbench asset mount instead of the application root.

### Prefer declared Workbench route paths and diagnose collisions

Workbench exposes all committed routes in its global layout, including parameterized routes and pages outside navigation. The Shell uses declared paths below its UI base URL when unambiguous. Overlapping routes from different plugin instances and reserved Shell paths use canonical plugin URLs with visible collision diagnostics. Canonical URLs remain available, and aliases are recomputed after publication changes.

### Admit shared Workbench Cap'n Web before connecting module identity

Workbench now declares `capnweb` as a peer, while final Host applications provide the runtime directly. Development, static application builds, and production dynamic sources check a target publisher's peer and actual installed version before connecting its import to the Host Workbench module. A base library that supplies a Workbench target class is checked by its peer declaration even when it has no generated publication marker. Independent private RPC packages keep their own resolution. Source builds also require a matching development copy; installed publishers only require their published peer and installed runtime.

### Improve Workbench sidebar scrolling and document navigation

The built-in Workbench overview scrolls independently with fixed tabs. Configuration and Markdown headings appear in a separate searchable outline tab even when the editor does not overflow. Outline tracking scrolls only its own list, uses the available sidebar height, and follows the active editor. Sidebar tab switches retain mounted scroll positions.

### Keep implementation modules private

Remove unused Workbench `/paths`, `/internal/shell` and `/internal/definition` exports and the unused
Rolldown `/internal/static-config-environment-vite` adapter. Package-local white-box tests import
source modules directly. The generated browser React Bridge ABI remains isolated at
`@pluxel/workbench/internal/react`.

Workbench owner publication now captures the owner directly in the frozen `publish()` capability, removing the intermediate `WorkbenchService` wrapper while preserving PluginPart rejection and backend admission. Remove the unused `createWorkbenchBackend` factory and `WorkbenchBackendFactory` type; custom internal test assembly still injects a backend through the shared service installation path. Shell asset paths are owned locally by Workbench.

### Fill the available Workbench space for federated pages

Give federated View and Attachment renderers a sized mount container. Pages now fill their editor pane instead of shrinking to their content width, and Pane Kit responds to the actual available width when choosing columns or drawers.

### Simplify latest-state RPC subscriptions

Add `createWorkbenchWatch()` to `@pluxel/workbench/server`. Plugin targets connect a local
revision subscription to a remote observer without implementing a separate subscription target.
The helper owns callback references, invocation results and local registration cleanup, closes on
open abort or observer failure, and bounds notification work to one in-flight callback and the latest
pending revision. It is intended for snapshot invalidation, not lossless event delivery.
