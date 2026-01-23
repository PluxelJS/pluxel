import './setup'

import { Context } from '@pluxel/context'
import type { CommitSummary, PluginConstructor, PluginIdentifier, PluginService } from '../plugins'
import { checkPluginDecorator, getPluginInfo } from '../plugins'
import type { ConfigService } from '../services/config/ConfigService'

// ---------------------------------------------------------------------------
// Stable public surface for @pluxel/core/test
// Keep exports explicit to avoid accidental API drift.
// ---------------------------------------------------------------------------

export { Context } from '@pluxel/context'
export {
	__registerConfigSchema__,
	__registerUsedFeature__,
	__registerUsedFeatures__,
	BaseFeature,
	BasePlugin,
	Config,
	checkPluginDecorator,
	clearParamToken,
	FeatureHost,
	ForkablePlugin,
	getPluginInfo,
	getRequiredPluginDependencies,
	Plugin,
	pluginMethodDecorator,
	requirePluginDependency,
	resolvePluginDependency,
	setParamToken,
	setParamTokens,
	UseFeature,
} from '../plugins'
export { EventsService } from '../services/events/EventsService'
export { LoggerService } from '../services/LoggerService'
export { EffectScopeService } from '../services/scope/EffectScopeService'

export type CommitAttempt = { ok: true; summary: CommitSummary } | { ok: false; error: unknown }

export type TestHost = {
	/** Root context for this test. */
	ctx: Context

	/**
	 * Register a plugin ctor into the current *draft* container.
	 * Call `commit()`/`commitStrict()` to actually build a container and start it.
	 */
	register: (Plugin: PluginConstructor, opts?: { provideBase?: boolean }) => void
	/** Convenience: register multiple ctors into the draft container. */
	registerAll: (...plugins: PluginConstructor[]) => void

	/** Fork helpers. */
	fork: PluginService['fork']
	registerFork: PluginService['registerFork']
	getFork: PluginService['getFork']
	listForks: PluginService['listForks']

	/** Runtime state helpers. */
	isRunning: PluginService['isRunning']
	/**
	 * Read the current in-memory instance cache.
	 * Does not instantiate or start anything.
	 */
	get: <T extends PluginIdentifier>(id: T) => InstanceType<T> | undefined
	/** Like `get()`, but throws with a helpful message when missing. */
	getOrThrow: <T extends PluginIdentifier>(id: T) => InstanceType<T>
	/** Config injection helpers (LoaderService-like). */
	config: ConfigService
	/**
	 * Patch the config snapshot used by `@Config` injection.
	 * - Use plugin ctor or plugin name (`pluginInfo.id`) as target.
	 * - Takes effect on the next (re)start of that plugin.
	 */
	setConfig: (target: PluginConstructor | string, configRecord: Record<string, unknown>) => void
	enablePlugins: (...names: string[]) => void
	disablePlugins: (...names: string[]) => void
	isEnabled: (name: string) => boolean

	/** Draft mutations. */
	/**
	 * Unregister a plugin from the draft container.
	 * Default behavior is cascading: dependents are removed too (to keep DI valid).
	 */
	unregister: (id: PluginIdentifier) => void
	/**
	 * Restart a plugin on next commit.
	 * Default behavior is cascading: dependents are restarted too.
	 */
	restart: (id: PluginIdentifier, opts?: { cascadeDependents?: boolean }) => void
	/**
	 * Replace a plugin implementation (HMR-style).
	 * Keeps old tokens resolvable via DI aliases and schedules a restart of the affected subtree.
	 */
	replace: (id: PluginIdentifier, next: PluginConstructor) => void

	/** Commit and lifecycle. */
	/**
	 * Build/verify container, apply lifecycle changes, and return a typed result.
	 * Prefer this when you want to assert build failures.
	 */
	tryCommit: () => Promise<CommitAttempt>
	/** Like `tryCommit()` but throws on build failure. */
	commit: () => Promise<CommitSummary>
	/** Like `commit()` but throws if any plugin failed to start. */
	commitStrict: () => Promise<CommitSummary>
	/**
	 * Convenience: register + commitStrict + getOrThrow.
	 * Good for single-plugin tests.
	 */
	start: <T extends PluginConstructor>(
		Plugin: T,
		opts?: { provideBase?: boolean },
	) => Promise<InstanceType<T>>

	/** Introspection over the last successful commit. */
	lastCommit: () => CommitSummary | undefined
	listServiceIds: () => unknown[]
	listPlugins: () => PluginConstructor[]
	hasService: (id: unknown) => boolean
	hasPlugin: (Plugin: PluginConstructor) => boolean

	/** Cleanup. */
	dispose: () => Promise<void>
}

export type PluginTestHost = TestHost

/**
 * Create a test host (Context + plugin registry helpers).
 *
 * Notes:
 * - This function is *side-effectful*: importing `@pluxel/core/test` installs core services.
 * - All `register/unregister/restart/replace` operations are draft-only until you `commit()`.
 */
export function createTestHost(config: Context.Config = {}): TestHost {
	const cfg: Context.Config = {
		...config,
		// Tests should be hermetic by default: avoid touching the real filesystem unless explicitly requested.
		fs: { mode: 'memory', ...(config.fs ?? {}) },
	}
	const ctx = new Context({ name: 'test', ...cfg })
	const registry = ctx.registry as PluginService

	const configService = ctx.configService

	const lastCommit = () => registry.lastCommit

	const listServiceIds = () => [...(lastCommit()?.container.services.keys() ?? [])]
	const listPlugins = () =>
		listServiceIds().filter(
			(id): id is PluginConstructor => typeof id === 'function' && checkPluginDecorator(id),
		)
	const hasService = (id: unknown) =>
		(lastCommit()?.container.services as Map<unknown, unknown> | undefined)?.has(id) ?? false
	const hasPlugin = (Plugin: PluginConstructor) => hasService(Plugin)

	const get = <T extends PluginIdentifier>(id: T) => registry.getInstance(id)
	const getOrThrow = <T extends PluginIdentifier>(id: T) => {
		const instance = get(id)
		if (!instance) {
			throw new Error(
				`Plugin instance not found (did you forget to register+commit?): ${String(id)}`,
			)
		}
		return instance
	}

	const tryCommit = async (): Promise<CommitAttempt> => {
		const result = await registry.commit()
		if (!result.ok) return { ok: false, error: result.err }
		const summary = registry.lastCommit
		if (!summary)
			return { ok: false, error: new Error('commit succeeded but lastCommit is missing') }
		return { ok: true, summary }
	}

	const host: TestHost = {
		ctx,

		register: (Plugin, opts) => registry.register(Plugin, opts),
		registerAll: (...plugins) => {
			for (const Plugin of plugins) registry.register(Plugin)
		},

		fork: registry.fork.bind(registry),
		registerFork: registry.registerFork.bind(registry),
		getFork: registry.getFork.bind(registry),
		listForks: registry.listForks.bind(registry),

		isRunning: registry.isRunning.bind(registry),
		get,
		getOrThrow,
		config: configService,
		setConfig: (target, configRecord) => {
			const name = typeof target === 'string' ? target : getPluginInfo(target).id
			configService.patchConfig(name, configRecord)
		},
		enablePlugins: (...names) => configService.enableInConfig(...names),
		disablePlugins: (...names) => configService.disableInConfig(...names),
		isEnabled: (name) => configService.isEnabledInConfig(name),

		unregister: (id) => registry.unregister(id),
		restart: (id, opts) => registry.restart(id, opts),
		replace: (id, next) => registry.replace(id, next),

		tryCommit,
		commit: async () => {
			const attempted = await tryCommit()
			if (attempted.ok === false) {
				throw attempted.error instanceof Error
					? attempted.error
					: new Error(String(attempted.error))
			}
			return attempted.summary
		},
		commitStrict: async () => {
			const result = await registry.commitStrict()
			if (!result.ok) {
				throw result.err instanceof Error ? result.err : new Error(String(result.err))
			}
			const summary = registry.lastCommit
			if (!summary) throw new Error('commitStrict succeeded but lastCommit is missing')
			return summary
		},
		start: async (Plugin, opts) => {
			host.register(Plugin, opts)
			await host.commitStrict()
			return host.getOrThrow(Plugin)
		},

		lastCommit,
		listServiceIds,
		listPlugins,
		hasService,
		hasPlugin,

		dispose: async () => {
			try {
				// Ensure any uncommitted draft ops don't leak across tests.
				registry.resetDraft()

				// Unregister all decorated plugins from the last committed container (if any).
				for (const id of listPlugins()) registry.unregister(id)
				if (lastCommit()) await host.commit()
			} finally {
				registry.resetDraft()
				ctx.disposeAll()
			}
		},
	}

	return host
}

export function createPluginTestHost(config: Context.Config = {}): PluginTestHost {
	return createTestHost(config)
}

/**
 * Run a test with an isolated host and guaranteed cleanup.
 * This is the recommended helper for plugin-system tests.
 */
export async function withTestHost<T>(
	fn: (host: TestHost) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const host = createTestHost(config)
	try {
		return await fn(host)
	} finally {
		await host.dispose()
	}
}

/** Back-compat alias for older tests. Prefer `withTestHost`. */
export async function withPluginTestHost<T>(
	fn: (host: TestHost) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	return withTestHost(fn, config)
}

export type TestContext = {
	ctx: Context
	dispose: () => void
}

/**
 * Create a bare Context for service-level tests (no plugin host helpers).
 * Prefer `withTestContext()` for automatic cleanup.
 */
export function createTestContext(config: Context.Config = {}): TestContext {
	const cfg: Context.Config = {
		...config,
		// Tests should be hermetic by default: avoid touching the real filesystem unless explicitly requested.
		fs: { mode: 'memory', ...(config.fs ?? {}) },
	}
	const ctx = new Context({ name: 'test', ...cfg })
	return {
		ctx,
		dispose: () => {
			// Best-effort cleanup; keeps tests isolated even if they didn't use host.
			try {
				ctx.registry.resetDraft()
				ctx.disposeAll()
				ctx.registry.resetDraft()
			} catch {
				/* ignore */
			}
		},
	}
}

/** Run a test with an isolated Context and guaranteed cleanup. */
export async function withTestContext<T>(
	fn: (ctx: Context) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const t = createTestContext(config)
	try {
		return await fn(t.ctx)
	} finally {
		t.dispose()
	}
}
