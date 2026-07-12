# Pluxel plugin guide for this repository

Read this before editing `plugins/`, Pluxel contracts, host configuration, or the lint setup. It is
the local, template-specific authoring guide for both contributors and coding agents.

## Work in the right boundary

| Path                       | Owner                                                                        |
| -------------------------- | ---------------------------------------------------------------------------- |
| `web`                      | Deployable Vite app, React/GQLens frontend and static host policy            |
| `plugins/example`          | Plugin lifecycle, configuration, business HTTP and plugin-owned capabilities |
| `packages/domain`          | Framework-neutral logic shared by the web app and plugin                     |
| `web/src/pluxel.static.ts` | Plugin catalog, persistence, Web Management and process/deployment policy    |

Do not move business state or HTTP into Web Management. Do not make the neutral domain package
depend on Pluxel, React or host policy.

## Standard plugin shape

```ts
import { BasePlugin, Plugin, v } from '@pluxel/runtime'

const WorkerConfig = v.object({
	concurrency: v.optional(v.number(), 4),
})

@Plugin({ name: 'WorkerPlugin' })
export class WorkerPlugin extends BasePlugin {
	private readonly config = this.configs.use(WorkerConfig)

	constructor(private readonly database: DatabasePlugin) {
		super()
	}

	override async init(signal: AbortSignal) {
		const worker = await createWorker(this.config, { signal })
		this.ctx.effects.defer(() => worker.stop())

		this.ctx.http.plugin.routes((app) => app.get('/status', () => worker.status()))

		this.plugins.use(AuditPlugin, (audit) => audit.registerSource(this))
		this.ctx.webManagement.use((web) => {
			web.ui.register(dashboard)
		})
	}
}
```

Use the shape as an ownership map:

- required plugin dependencies belong in constructors; optional integrations use `plugins.use()`;
- module scope and class fields declare metadata; they do not start I/O or load lazy features;
- constructors contain only plugins without which this plugin cannot work;
- `init()` validates startup, creates resources, registers business capabilities and cleanup;
- `webManagement.use()` contains only optional management UI/RPC/SSE/state work.

## Make these decisions explicitly

| Question                                                             | Use                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Can the plugin work without another plugin?                          | No: constructor dependency. Yes: `this.plugins.use()` integration.       |
| Does a component need an independent lifecycle/replacement boundary? | Yes: plugin. No: feature.                                                |
| Is an endpoint part of the product or only the management UI?        | Product: `ctx.http.plugin`. Management: `webManagement.use()`.           |
| When is a resource released?                                         | Register an idempotent `ctx.effects.defer()` immediately after creation. |

Constructor dependency tokens must use runtime imports, never `import type`. Pluxel plugin sources
must run through the configured Vite/Rolldown pipeline so decorator metadata exists.

## Config, lifecycle and management

- Put defaults in the schema and call `this.configs.use(schema)` in a normal class field.
- Read the normalized config only in `init()` or later; never in a constructor or another field.
- If required configuration or an upstream service is invalid, let `init()` fail with an actionable
  error. Do not log and continue in a half-started state.
- Register cleanup immediately and make it safe after partial initialization or repeated teardown.
- Plugins never call `process.exit()`; the host decides whether startup facts require exit or
  degraded operation.
- Keep business HTTP and state working when `webManagement: false`. Management state is a UI
  projection, not the business source of truth.

The example test intentionally starts with Web Management disabled. Preserve that coverage when
adding plugin capabilities.

## Pluxel Oxlint rules

The root `oxlint.config.ts` loads `@pluxel/rolldown/oxlint`. These are correctness and ownership
rules, not cosmetic style preferences.

| Rules                                            | What they require                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `plugin-base-class-requires-plugin-registration` | Concrete plugin base subclasses use `@Plugin(...)`; reusable bases are `abstract`.              |
| `plugin-constructor-no-type-only-imports`        | Constructor dependency tokens are runtime imports.                                              |
| `plugin-no-process-exit`                         | Plugins report failure; hosts own process policy.                                               |
| `features-use-top-level-class`                   | Required feature metadata stays on a module-top-level plugin class.                             |
| `features-load-no-class-field`                   | Lazy features load in `init()` or a later runtime method.                                       |
| `features-load-requires-defined-spec`            | `features.load()` receives an imported spec or module-level `const` from `defineLazyFeature()`. |
| `features-load-no-static-load`                   | A lazy feature uses a genuine dynamic `import(...)` boundary.                                   |
| `configs-use-top-level-class`                    | Config metadata stays on a module-top-level plugin class.                                       |
| `configs-use-no-private-field`                   | Injected config uses a normal TypeScript `private` field, not `#private`.                       |
| `configs-use-no-early-read`                      | Config is read only after runtime injection.                                                    |
| `configs-use-no-redefault`                       | Defaults live in the schema; normalized values are not defaulted again.                         |
| `log-no-rendered-error`                          | Raw errors are structured properties, not interpolated/stringified messages.                    |
| `log-canonical-error-prop`                       | Use one raw `{ error }` or `{ err }` field.                                                     |
| `no-direct-logtape-get-logger`                   | Plugin code derives logging from `ctx.logger`.                                                  |
| `no-workspace-root-import`                       | Rolldown workspace helpers use explicit public subpaths.                                        |
| `runtime-type-augmentations`                     | Management RPC/SSE/state has a shared contract or `@pluxel/runtime/web` augmentation.           |

Correct error logging:

```ts
try {
	await sync()
} catch (error) {
	this.ctx.logger.error('sync failed', { error })
}
```

Run `pnpm lint:fix` for safe mechanical fixes, then resolve remaining diagnostics by correcting
ownership. Keep unused-disable reporting enabled; use a narrow suppression only for a confirmed
false positive and document why.

## Done means verified

```sh
pnpm lint:fix
pnpm verify
```

Before finishing, confirm required/optional, plugin/feature and business/management choices are
visible in the code; every resource has cleanup; the disabled-management test passes; and public UI
contracts remain discoverable to consumers.
