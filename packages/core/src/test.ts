import './services/index'
import {
	checkPluginDecorator,
	getPluginInfo,
	type BasePlugin,
	type CommitSummary,
	Context,
	type ForkablePluginConstructor,
	type PluginConstructor,
	type PluginIdentifier,
	type PluginService,
} from './index'

export {
	BaseFeature,
	BasePlugin,
	Config,
	defineOptionalFeature,
	FeatureHost,
	ForkablePlugin,
	HostBoundFeature,
	Plugin,
	checkPluginDecorator,
	clearParamToken,
	getPluginInfo,
	setParamToken,
	setParamTokens,
	UseFeature,
} from './index'
export { Context } from './index'
export type {
	CommitSummary,
	ForkablePluginConstructor,
	PluginConstructor,
	PluginIdentifier,
} from './index'

type NamespacedConfigKey = `${string}.${string}`
type CoreHostConfigTarget = PluginConstructor | string

type NonFunctionPropertyNames<T extends object> = {
	[K in keyof T]-?: T[K] extends (...args: any[]) => any ? never : K
}[keyof T]

type PluginOwnFields<T extends PluginConstructor> = Omit<InstanceType<T>, keyof BasePlugin>

export type CoreHostConfigPatch<T extends PluginConstructor> = Partial<
	Pick<PluginOwnFields<T>, NonFunctionPropertyNames<PluginOwnFields<T>>>
> &
	Partial<Record<string | NamespacedConfigKey, unknown>>

export type CoreHostConfigPatchByName = Record<string, unknown>

export type CoreHostConfigPatchFor<TTarget extends CoreHostConfigTarget> =
	TTarget extends PluginConstructor ? CoreHostConfigPatch<TTarget> : CoreHostConfigPatchByName

export type CoreHostConfigHandle<TTarget extends CoreHostConfigTarget> = {
	readonly name: string
	set: (patch: CoreHostConfigPatchFor<TTarget>) => void
	unset: (...keys: string[]) => void
	rev: () => number
	enable: () => void
	disable: () => void
	enabled: () => boolean
}

export interface CoreHost {
	readonly ctx: Context

	add(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): CoreHost
	add(Plugins: readonly PluginConstructor[], opts?: { provideBase?: boolean }): CoreHost
	remove(id: PluginIdentifier): CoreHost
	remove(ids: readonly PluginIdentifier[]): CoreHost
	restart: (id: PluginIdentifier, opts?: { cascadeDependents?: boolean }) => CoreHost
	replace: (
		id: PluginIdentifier,
		next: PluginConstructor,
		opts?: { cascadeDependents?: boolean; provideBase?: boolean },
	) => CoreHost
	fork: <T extends ForkablePluginConstructor>(
		Plugin: T,
		forkId: string,
		opts?: { provideBase?: boolean },
	) => T

	commit(): Promise<CommitSummary>
	commitAllowFail(): Promise<CommitSummary>

	isRunning: (id: PluginIdentifier) => boolean
	get: <T extends PluginIdentifier>(id: T) => InstanceType<T> | undefined
	require: <T extends PluginIdentifier>(id: T) => InstanceType<T>

	cfg<T extends PluginConstructor>(target: T): CoreHostConfigHandle<T>
	cfg(target: string): CoreHostConfigHandle<string>

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

export type CoreTestContext = {
	readonly ctx: Context
	dispose: () => Promise<void>
}

export type CoreHostOptions = {
	prepareCommit?: (ctx: Context) => Promise<void> | void
}

function normalizeConfig(config: Context.Config): Context.Config {
	return Object.assign({}, config, {
		root: config.root ?? {},
		fs: Object.assign({ mode: 'memory' }, config.fs),
	}) as Context.Config
}

function assertCommitSummary(
	result: Awaited<ReturnType<PluginService['commit']>>,
	registry: PluginService,
): CommitSummary {
	if (!result.ok) throw result.err instanceof Error ? result.err : new Error(String(result.err))
	const summary = registry.lastCommit
	if (!summary) throw new Error('commit succeeded but lastCommit is missing')
	return summary
}

export function createCoreHost(
	config: Context.Config = {},
	options: CoreHostOptions = {},
): CoreHost {
	let host!: CoreHost

	const ctx = new Context({ name: 'test', ...normalizeConfig(config) })
	const registry = ctx.registry as PluginService
	const configService = ctx.configService

	const last = () => registry.lastCommit
	const services = () => [...(last()?.graph.keys() ?? [])]
	const plugins = () =>
		services().filter(
			(id): id is PluginConstructor =>
				typeof id === 'function' && checkPluginDecorator(id as PluginConstructor),
		)
	const has = (id: unknown) => last()?.graph.has(id as never) ?? false

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
		await options.prepareCommit?.(ctx)
		return assertCommitSummary(await registry.commitStrict(), registry)
	}

	async function commitAllowFail(): Promise<CommitSummary> {
		await options.prepareCommit?.(ctx)
		return assertCommitSummary(await registry.commit(), registry)
	}

	const cfgHandle = <TTarget extends CoreHostConfigTarget>(
		name: string,
	): CoreHostConfigHandle<TTarget> => ({
		name,
		set: (patch) => configService.patchConfig(name, patch as Record<string, unknown>),
		unset: (...keys) => configService.unsetConfigKeys(name, keys),
		rev: () => configService.getConfigRevision(name),
		enable: () => configService.enableInConfig(name),
		disable: () => configService.disableInConfig(name),
		enabled: () => configService.isEnabledInConfig(name),
	})

	const resolveCfgName = (target: CoreHostConfigTarget) =>
		typeof target === 'string' ? target : getPluginInfo(target).id

	function add(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): CoreHost
	function add(Plugins: readonly PluginConstructor[], opts?: { provideBase?: boolean }): CoreHost
	function add(
		PluginOrPlugins: PluginConstructor | readonly PluginConstructor[],
		opts?: { provideBase?: boolean },
	): CoreHost {
		if (typeof PluginOrPlugins === 'function') {
			registry.register(PluginOrPlugins, opts)
			return host
		}
		for (const Plugin of PluginOrPlugins) registry.register(Plugin, opts)
		return host
	}

	function remove(id: PluginIdentifier): CoreHost
	function remove(ids: readonly PluginIdentifier[]): CoreHost
	function remove(idOrIds: PluginIdentifier | readonly PluginIdentifier[]): CoreHost {
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
		replace: (id, next, opts) => {
			registry.replace(id, next, opts)
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

		cfg: ((target: PluginConstructor | string) =>
			cfgHandle(resolveCfgName(target))) as CoreHost['cfg'],

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

export async function withCoreHost<T>(
	fn: (host: CoreHost) => Promise<T> | T,
	config: Context.Config = {},
	options: CoreHostOptions = {},
): Promise<T> {
	const host = createCoreHost(config, options)
	try {
		return await fn(host)
	} finally {
		await host.dispose()
	}
}

export function createCoreContext(config: Context.Config = {}): CoreTestContext {
	const ctx = new Context({ name: 'test', ...normalizeConfig(config) })
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

export async function withCoreContext<T>(
	fn: (ctx: Context) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const t = createCoreContext(config)
	try {
		return await fn(t.ctx)
	} finally {
		await t.dispose()
	}
}
