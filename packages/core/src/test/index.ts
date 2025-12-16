import '../reflection'

import '../services'

import { Context } from '@pluxel/context'
import { checkPluginDecorator, getPluginInfo } from '../plugins/PluginDecorator'
import type { CommitSummary, PluginService } from '../plugins/service/PluginService'
import type { PluginConstructor, PluginIdentifier } from '../plugins/types'
import type { ConfigService } from '../services/ConfigService'

export * from '../index'
export { EffectScopeService } from '../services/EffectScopeService'
export { EventsService } from '../services/EventsService'
export { LoggerService } from '../services/LoggerService'

export type CommitAttempt = { ok: true; summary: CommitSummary } | { ok: false; error: any }

export type TestHost = {
	/** Root context for this test. */
	ctx: Context

	/** Register plugin ctors into the draft container. */
	register: (Plugin: PluginConstructor, opts?: { provideBase?: boolean }) => void
	registerAll: (...plugins: PluginConstructor[]) => void

	/** Fork helpers. */
	fork: PluginService['fork']
	registerFork: PluginService['registerFork']
	getFork: PluginService['getFork']
	listForks: PluginService['listForks']

	/** Runtime state helpers. */
	isRunning: PluginService['isRunning']
	optional: PluginService['optional']
	get: <T extends PluginIdentifier>(id: T) => InstanceType<T> | undefined
	getOrThrow: <T extends PluginIdentifier>(id: T) => InstanceType<T>
	/** Config injection helpers (LoaderService-like). */
	config: ConfigService
	setConfig: (
		target: PluginConstructor | string,
		configRecord: Record<string, unknown>,
		meta?: Record<string, unknown>,
	) => void
	enablePlugins: (...names: string[]) => void
	disablePlugins: (...names: string[]) => void
	isEnabled: (name: string) => boolean

	/** Draft mutations. */
	unregister: (id: PluginIdentifier) => void
	restart: (id: PluginIdentifier, opts?: { cascadeDependents?: boolean }) => void
	replace: (id: PluginIdentifier, next: PluginConstructor) => void

	/** Commit and lifecycle. */
	tryCommit: () => Promise<CommitAttempt>
	commit: () => Promise<CommitSummary>
	commitStrict: () => Promise<CommitSummary>
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

export function createTestHost(config: Context.Config = {}): TestHost {
	const ctx = new Context({ name: 'test', ...config })
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
		optional: registry.optional.bind(registry) as TestHost['optional'],
		get,
		getOrThrow,
		config: configService,
		setConfig: (target, configRecord, meta = {}) => {
			const name = typeof target === 'string' ? target : getPluginInfo(target).id
			configService.patchConfigSnapshot(name, { meta, configRecord })
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
			const summary = await host.commit()
			if (summary.failed.length) {
				throw new Error(`Some plugins failed to start: ${summary.failed.map(String).join(', ')}`)
			}
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

export async function withPluginTestHost<T>(
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

export async function withTestHost<T>(
	fn: (host: TestHost) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	return withPluginTestHost(fn, config)
}

export type TestContext = {
	ctx: Context
	dispose: () => void
}

export function createTestContext(config: Context.Config = {}): TestContext {
	const ctx = new Context({ name: 'test', ...config })
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
