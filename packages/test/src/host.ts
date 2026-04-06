import type {
	BasePlugin,
	CommitSummary,
	ForkablePluginConstructor,
	PluginConstructor,
	PluginIdentifier,
	PluginService,
} from '@pluxel/core'
import { Context, checkPluginDecorator, getPluginInfo } from '@pluxel/core'

type NamespacedConfigKey = `${string}.${string}`
type HostConfigTarget = PluginConstructor | string

type NonFunctionPropertyNames<T extends object> = {
	[K in keyof T]-?: T[K] extends (...args: any[]) => any ? never : K
}[keyof T]

type PluginOwnFields<T extends PluginConstructor> = Omit<InstanceType<T>, keyof BasePlugin>

export type ConfigPatch<T extends PluginConstructor> = Partial<
	Pick<PluginOwnFields<T>, NonFunctionPropertyNames<PluginOwnFields<T>>>
> &
	Partial<Record<NamespacedConfigKey, unknown>>

export type ConfigPatchByName = Record<string, unknown>

export type ConfigPatchFor<TTarget extends HostConfigTarget> = TTarget extends PluginConstructor
	? ConfigPatch<TTarget>
	: ConfigPatchByName

export type HostConfigHandle<TTarget extends HostConfigTarget> = {
	readonly name: string
	set: (patch: ConfigPatchFor<TTarget>) => void
	unset: (...keys: string[]) => void
	rev: () => number
	enable: () => void
	disable: () => void
	enabled: () => boolean
}

export interface Host {
	readonly ctx: Context

	add(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): Host
	add(Plugins: readonly PluginConstructor[], opts?: { provideBase?: boolean }): Host
	remove(id: PluginIdentifier): Host
	remove(ids: readonly PluginIdentifier[]): Host
	restart: (id: PluginIdentifier, opts?: { cascadeDependents?: boolean }) => Host
	replace: (id: PluginIdentifier, next: PluginConstructor) => Host

	/** Create+register a fork ctor into draft; returns the fork ctor. */
	fork: <T extends ForkablePluginConstructor>(
		Plugin: T,
		forkId: string,
		opts?: { provideBase?: boolean },
	) => T

	commit(): Promise<CommitSummary>
	/** Non-strict commit: plugin start failures are reflected in the summary instead of throwing. */
	commitAllowFail(): Promise<CommitSummary>

	isRunning: (id: PluginIdentifier) => boolean
	get: <T extends PluginIdentifier>(id: T) => InstanceType<T> | undefined
	require: <T extends PluginIdentifier>(id: T) => InstanceType<T>

	cfg<T extends PluginConstructor>(target: T): HostConfigHandle<T>
	cfg(target: string): HostConfigHandle<string>

	/** Convenience: add + commit(strict) + require */
	start: <T extends PluginConstructor>(
		Plugin: T,
		opts?: { provideBase?: boolean },
	) => Promise<InstanceType<T>>

	last: () => CommitSummary | undefined
	services: () => unknown[]
	plugins: () => PluginConstructor[]
	has: (id: unknown) => boolean

	dispose: () => Promise<void>
}

export function createHost(config: Context.Config = {}): Host {
	let host!: Host

	const cfg: Context.Config = {
		root: config.root ?? {},
		...config,
		fs: { mode: 'memory', ...config.fs },
	}
	const ctx = new Context({ name: 'test', ...cfg })
	const registry = ctx.registry as PluginService
	const configService = ctx.configService

	const last = () => registry.lastCommit

	const services = () => [...(last()?.container.services.keys() ?? [])]
	const plugins = () =>
		services().filter(
			(id): id is PluginConstructor => typeof id === 'function' && checkPluginDecorator(id),
		)
	const has = (id: unknown) =>
		(last()?.container.services as Map<unknown, unknown> | undefined)?.has(id) ?? false

	const get = <T extends PluginIdentifier>(id: T) => registry.getInstance(id)
	const require = <T extends PluginIdentifier>(id: T) => {
		const instance = get(id)
		if (!instance) {
			throw new Error(
				`Plugin instance not running: ${String(id)} (did you forget to add+commit, or did it fail to start?)`,
			)
		}
		return instance
	}

	async function commit(): Promise<CommitSummary> {
		const result = await registry.commitStrict()
		if (!result.ok) throw result.err instanceof Error ? result.err : new Error(String(result.err))
		const summary = registry.lastCommit
		if (!summary) throw new Error('commit succeeded but lastCommit is missing')
		return summary
	}

	async function commitAllowFail(): Promise<CommitSummary> {
		const result = await registry.commit()
		if (!result.ok) throw result.err instanceof Error ? result.err : new Error(String(result.err))
		const summary = registry.lastCommit
		if (!summary) throw new Error('commit succeeded but lastCommit is missing')
		return summary
	}

	const cfgHandle = <TTarget extends HostConfigTarget>(
		name: string,
	): HostConfigHandle<TTarget> => ({
		name,
		set: (patch) => configService.patchConfig(name, patch as Record<string, unknown>),
		unset: (...keys) => configService.unsetConfigKeys(name, keys),
		rev: () => configService.getConfigRevision(name),
		enable: () => configService.enableInConfig(name),
		disable: () => configService.disableInConfig(name),
		enabled: () => configService.isEnabledInConfig(name),
	})

	const resolveCfgName = (target: HostConfigTarget) =>
		typeof target === 'string' ? target : getPluginInfo(target).id

	function add(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): Host
	function add(Plugins: readonly PluginConstructor[], opts?: { provideBase?: boolean }): Host
	function add(
		PluginOrPlugins: PluginConstructor | readonly PluginConstructor[],
		opts?: { provideBase?: boolean },
	): Host {
		if (typeof PluginOrPlugins === 'function') {
			registry.register(PluginOrPlugins, opts)
			return host
		}
		for (const Plugin of PluginOrPlugins) registry.register(Plugin, opts)
		return host
	}

	function remove(id: PluginIdentifier): Host
	function remove(ids: readonly PluginIdentifier[]): Host
	function remove(idOrIds: PluginIdentifier | readonly PluginIdentifier[]): Host {
		if (Array.isArray(idOrIds)) {
			for (const id of idOrIds) registry.unregister(id)
			return host
		}
		registry.unregister(idOrIds as PluginIdentifier)
		return host
	}

	host = {
		ctx,

		add,
		remove,
		restart: (id, opts) => {
			registry.restart(id, opts)
			return host
		},
		replace: (id, next) => {
			registry.replace(id, next)
			return host
		},

		fork: (Plugin, forkId, opts) => {
			return registry.registerFork(Plugin, forkId, opts) as unknown as typeof Plugin
		},

		commit,
		commitAllowFail,

		isRunning: registry.isRunning.bind(registry),
		get,
		require,

		cfg: ((target: PluginConstructor | string) => cfgHandle(resolveCfgName(target))) as Host['cfg'],

		start: async (Plugin, opts) => {
			host.add(Plugin, opts)
			await host.commit()
			return host.require(Plugin)
		},

		last,
		services,
		plugins,
		has,

		dispose: async () => {
			try {
				registry.resetDraft()
				for (const id of plugins()) registry.unregister(id)
				if (last()) {
					try {
						await host.commitAllowFail()
					} catch {
						/* best-effort cleanup */
					}
				}
			} finally {
				registry.resetDraft()
				await ctx.effects.dispose()
			}
		},
	}

	return host
}

export async function withHost<T>(
	fn: (host: Host) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const host = createHost(config)
	try {
		return await fn(host)
	} finally {
		await host.dispose()
	}
}

export type TestContext = {
	readonly ctx: Context
	dispose: () => Promise<void>
}

export function createContext(config: Context.Config = {}): TestContext {
	const cfg: Context.Config = {
		root: config.root ?? {},
		...config,
		fs: { mode: 'memory', ...config.fs },
	}
	const ctx = new Context({ name: 'test', ...cfg })
	return {
		ctx,
		dispose: async () => {
			try {
				ctx.registry.resetDraft()
				await ctx.effects.dispose()
				ctx.registry.resetDraft()
			} catch {
				/* ignore */
			}
		},
	}
}

export async function withContext<T>(
	fn: (ctx: Context) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const t = createContext(config)
	try {
		return await fn(t.ctx)
	} finally {
		await t.dispose()
	}
}
