---
packages:
  '@pluxel/context': major
  '@pluxel/core': major
  '@pluxel/host': major
  '@pluxel/host-dev': major
  '@pluxel/services': major
  '@pluxel/management': major
  '@pluxel/workbench': major
  '@pluxel/logging': major
  '@pluxel/rolldown': major
  '@pluxel/auth': major
  '@pluxel/vault-admin': major
  '@pluxel/wretch': major
  '@pluxel/fonts': major
  '@pluxel/canvas': major
  '@pluxel/echarts': major
  '@pluxel/takumi': major
  '@pluxel/takumi-markdown': major
  '@pluxel/takumi-markdown-typst': major
  '@pluxel/agent-tools': major
  '@pluxel/create': major
  '@pluxel/cli': major
---

## Compose explicitly installed runtime services

Host creation is asynchronous and prepares an explicit service list before Plugin admission. Service
plans validate identity, properties, reserved Core members and dependencies before creating resources;
preparation and shutdown preserve dependency order and clean partially prepared resources on failure.
Core provides its own host composition entry, optional service type catalogs and synchronous token-based
Context.require(), with stable missing-capability and access errors.

Persistence and Vault move to dedicated @pluxel/services entries. Vault explicitly requires Persistence,
loads its encryption implementation during preparation and flushes pending writes during Host cleanup.
Import Persistence helpers and Vault types from their service entries. The Runtime package is removed;
servicesPreset() supplies the official default service composition.

## Preserve identity through development and generated metadata

Host development passes service declarations through the shared Host path. Service declaration changes
replace the Host; failed asynchronous preparation creates a fresh compensation Host from the previous
successful declaration. Native ESM and evaluated plugins share official service identity. Plugin/config
metadata defaults to the Core toolchain, without requiring Runtime in independent service applications.

## Unify plugin authoring and service ownership

Plugin examples and official packages import the Core authoring model directly. Commands, Node modules
and Workers are explicitly installed services; their tokens, declarations and types live at the service
entries. Worker installations declare their Node module dependency. servicesPreset() combines these
installations without introducing a second application or lifecycle model. The default Core author entry no longer forwards raw
Context host construction helpers; service authors use @pluxel/core/host.

Host exposes generic configuration get/validate/patch/reset through its existing coordinator, preserving
Core validation, storage confirmation and generation notification. Management delegates to these
operations and retains browser report projection. Vault operations participate in owner and root
admission: stop drains accepted work, rejects cached handles and flushes after pending storage IO.

## Use standard tsdown application plugins

Applications configure entry and output through tsdown and install pluxel() from @pluxel/rolldown in
the ordinary plugins list. This replaces the application preset in the build subpath, retaining the
same freezer, artifact assembly and deployment validation.

## Separate business HTTP from management

Install http() from @pluxel/services/http and use ctx.require(Http) for the native generation-owned
Elysia application. Independent Hosts expose business requests through the root-only HttpServer token,
without management, Workbench or a listener. Official presets use the same installation and publication stages.
Host services may bind fixed Core lifecycle stages before Plugin admission; no dynamic registration or
secondary graph commit is introduced.

## Persist and manage Host state directly

Host owns configRecords and state.initial, optional borrowed document storage, read-only handling and
flush failure reporting. Status snapshots and retained lifecycle diagnostics, startup intent, provider
selection and fork operations share the same Host coordinator in standalone and default applications.
Service removeNodeMetadata hooks run before durable fork removal; failure retains the stopped fork so
cleanup can be retried.

Database moves from @pluxel/runtime/database to @pluxel/services/database. Install an explicit backend
from @pluxel/services/database/pglite or /postgres. Driver dependencies are optional and only the chosen
backend is imported. Missing installation reports the standard capability error. Database acquisition
and cached handle operations participate in root and owner drain; closing waits for accepted transactions.

## Share management, Workbench and development tooling

The authenticated management endpoint/client, Workbench publication/browser code and logging backend
move to independently selected packages. Vault administration is an ordinary explicitly installed Plugin.
Host-dev owns the existing local console executor and typed script surface at @pluxel/host-dev/console;
its Vite Host plugin accepts devConsole: true. Node and Workbench artifacts use ordinary Vite plugins and
the shared Host candidate boundary. Canceled management work is rejected before queued execution starts;
an admitted operation retains its existing completion and persistence semantics.

## Share startup declarations and transport ownership

Application startup and service test-host factories await the same createHost service preparation path. Official
plugins import validation and RPC contracts from their owning packages, removing the Runtime peer
where no runtime implementation is used. Services owns the Node HTTP/WebSocket carrier; Host-dev owns
the development console, and queued management mutations honor cancellation before admission.
