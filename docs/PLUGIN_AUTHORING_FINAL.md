# Plugin Authoring Surface — Final Design

Status: accepted target design. This document describes the only supported plugin authoring model after the repository-wide migration. Old APIs are removed rather than deprecated.

## Goals

- A plugin is a lifecycle and dependency unit, not a deployment-policy unit.
- Runtime capabilities are separated into always-on services and optional host capabilities.
- Plugin code remains independent from static/dynamic runtime routes and from Vite/HMR details.
- Disabled optional capabilities perform no initialization and do not affect plugin readiness.
- Build-time declarations remain pure data; registration is an explicit runtime action.
- Public APIs expose author concepts only. Toolchain metadata helpers stay internal.

## Capability boundary

Always-on runtime services:

- config and validated plugin config
- logger, events and effects
- HTTP plugin routes
- runtime persistence and plugin data
- plugin registry/lifecycle read surfaces

Optional host capabilities:

- Web Management: UI modules, builtin UI, interactions, plugin UI RPC/SSE and management state replication
- Vault: encrypted storage and host-side vault administration

HTTP is not a Web Management capability. A headless host still serves plugin HTTP routes.

## Canonical plugin shape

```ts
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ui } from '@pluxel/runtime/web-management'

const dashboardUi = ui(import.meta.url, './ui/index.tsx')

@Plugin({ name: 'BillingPlugin' })
export class BillingPlugin extends BasePlugin {
	config = this.configs.use(BillingConfig)

	constructor(private readonly accounts: AccountsPlugin) {
		super()
	}

	override init() {
		this.ctx.http.plugin.routes((app) => {
			app.get('/invoices', () => this.listInvoices())
		})

		this.ctx.webManagement.use((web) => {
			const status = web.state.collection<BillingStatus>({ name: 'status' })
			web.ui.register(dashboardUi)
			web.rpc.expose(() => new BillingRpc(this, status))
			web.sse.expose(() => this.createStatusStream())
		})
	}
}
```

`webManagement.use()` is the single optional-capability gate:

- the callback runs only when the host installed Web Management;
- when disabled, none of the callback body is evaluated;
- registrations inherit the current plugin context and effects lifetime;
- Web Management absence never makes the plugin fail to start.

The backend may share host-level registries, but every plugin receives a context-bound service view. Shared services must never switch a mutable current `ctx`; concurrent plugin initialization and asynchronous registrations therefore cannot leak plugin identity or effects scope across contexts. Backend installation and required internal access are runtime-only functions and are not methods on the plugin-visible gate.

There is deliberately no null RPC, null UI registry, or null SignalDB collection. Fake successful stateful APIs hide errors and make headless behavior ambiguous.

## Web Management surface

The callback receives exactly four author-facing domains:

```ts
interface PluginWebManagement {
	ui: PluginUiContributions
	rpc: PluginRpcRegistry
	sse: PluginSseRegistry
	state: PluginManagementState
}
```

### UI

```ts
web.ui.register(pluginUiModule)
web.ui.builtin.doc(...)
web.ui.interaction.surface(...)
web.ui.interaction.offer(...)
```

The three UI models remain distinct:

- remote module: plugin-owned browser code;
- builtin UI: host-rendered serializable descriptions;
- interaction: consumer/provider/session ownership protocol.

They share a namespace but are not collapsed into a generic contribution object.

### RPC and SSE

RPC and SSE are scoped automatically to the current plugin id. Plugins never repeat a namespace at registration sites. They exist only for plugin management UI communication and do not replace normal HTTP business APIs.

### Management state

`web.state.collection()` is the server-authoritative state replicated to plugin management UI. SignalDB is an implementation detail and is not named in the top-level author surface.

Management state is suitable for status views, builtin forms/actions and UI interaction state. It must not be used as a plugin's domain database or for state required by headless operation. Those uses belong to plugin data, persistence, or a provider plugin.

## UI declaration and build pipeline

`ui()` is a pure declaration:

```ts
const dashboardUi = ui(import.meta.url, './ui/index.tsx')
```

It does not accept a Context and has no `bind()` method. Runtime registration is always `web.ui.register(declaration)`.

Development behavior:

1. the host enables Web Management;
2. the Vite route installs the capability before plugin commit;
3. `web.ui.register()` passes source declarations to the route UI compiler;
4. compiler state and errors are published through extension diagnostics.

Production behavior:

1. the plugin/package build emits the UI remote artifact;
2. the server declaration is lowered to an artifact reference;
3. `web.ui.register()` registers that packaged artifact;
4. runtime never resolves source entry paths.

Build tooling may lower declaration data, but must not replace the public function with a different runtime API.

## Host configuration

Web Management has one top-level configuration source:

```ts
webManagement: false
```

or:

```ts
webManagement: {
	enabled: true,
	access: {
		exposure: 'private',
	},
}
```

This single value derives service installation, management HTTP/RPC/SSE routes, UI assets, extension registry and Vite UI compiler attachment. `adminAccess`, `extensionService.enabled`, internal HTTP control-plane flags and Vite booleans are not independent public switches.

If enabled configuration cannot install the capability, host startup fails. If disabled, the implementation bundle, compiler, watchers, routes and assets are not initialized.

## Dependencies and features

There are four non-overlapping concepts:

- constructor parameter: required plugin dependency;
- `this.plugins.use(PluginCtor, callback)`: optional running-plugin integration;
- `features.use(FeatureCtor)`: required plugin-local composition;
- `features.load(spec)`: optional/lazy plugin-local composition.

Plugin integration does not live on FeatureHost. `features.dep()` is removed. `features.load()` replaces the old probe-style naming because it performs asynchronous conditional loading rather than a synchronous probe.

Required plugin dependencies keep the established constructor DI model. Runtime tokens come from TypeScript `design:paramtypes`; authors do not duplicate constructor dependencies in `@Plugin` metadata. The established low-level token overrides remain available for abstract tokens and direct transpiler/runner paths that do not emit decorator metadata.

Feature declarations that affect config or required dependency metadata must be explicit in `@Plugin({ features: [...] })`. Correctness must not depend on a class-field AST transform.

## Lifecycle and cleanup

- `init()` failure fails that plugin's current lifecycle attempt.
- required dependents are blocked; unrelated plugins continue.
- `stop()` and effects cleanup run on stop/replacement.
- registration APIs collect cleanup into the current plugin effects scope.
- optional plugin integration callbacks re-run across provider replacement and may return cleanup functions.
- Web Management contributions never change plugin lifecycle readiness.

## Public package boundaries

- `@pluxel/runtime`: stable plugin authoring and always-on runtime APIs.
- `@pluxel/runtime/web-management`: pure server-side Web Management declarations and author types.
- `@pluxel/runtime/web`: browser plugin UI APIs.
- runtime route packages: host configuration and launchers.
- `@pluxel/runtime/toolchain`: generated metadata helpers used only by build tooling.

Imports from an author package must not install host services as a side effect. Host launchers own optional capability installation.

## Removed APIs

The migration removes, without compatibility aliases:

- `ctx.ext`
- `ui().bind(ctx)`
- `ctx.ext.ui.remote.packaged()` as an author API
- `ctx.ext.signaldb`
- `features.dep()`
- `features.tryUse()`
- `defineOptionalFeature()`
- `@UseFeature`
- independent public Web Management enable switches
- toolchain `__register*` and metadata mutation exports from the default author entry

## Verification requirements

- headless static and dynamic hosts start UI-contributing plugins without evaluating Web Management callbacks;
- enabled hosts install the capability before the first plugin commit;
- Vite does not create UI compilers or watchers when disabled;
- production builds register packaged UI through `web.ui.register()`;
- all repository plugins use the final API only;
- searches for removed API spellings return no active source usages;
- core lifecycle, runtime, static/dynamic, UI, toolchain and project test suites pass.
