import './services/index'
import {
	checkPluginDecorator,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
	type BasePlugin,
	type CommitSummary,
	Context,
	type ForkablePluginConstructor,
	type PluginLifecycleIssue,
	type PluginLifecycleIssueKind,
	type PluginLifecycleIssuePhase,
	type PluginConstructor,
	type PluginIdentifier,
	type PluginNodeAddressSnapshot,
	type PluginNodeSlot,
	type PluginService,
} from './index'

export {
	BasePlugin,
	ForkablePlugin,
	Plugin,
	checkPluginDecorator,
	collectPluginLifecycleBlocked,
	collectPluginLifecycleDrainErrors,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	definePluginRef,
	getPluginDefinitionFacts,
	getPluginInfo,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleDrainErrorIssue,
	isPluginLifecycleNotStartedIssue,
	pluginNodeAddressOf,
} from './index'
export { Context } from './index'
export type {
	CommitSummary,
	ForkablePluginConstructor,
	PluginCommitChanges,
	PluginDefinitionAddressSnapshot,
	PluginLifecycleIssue,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginLifecycleIssuePredicate,
	PluginNodeAddressSnapshot,
	PluginNodeSlot,
	PluginRef,
	PluginReplacement,
	PluginConstructor,
	PluginIdentifier,
	RuntimeUpdateCommitSummary,
} from './index'

type NonFunctionPropertyNames<T extends object> = {
	[K in keyof T]-?: T[K] extends (...args: any[]) => any ? never : K
}[keyof T]

type PluginOwnFields<T extends PluginConstructor> = Omit<InstanceType<T>, keyof BasePlugin>

export type CoreHostConfigPatch<T extends PluginConstructor> = Partial<
	Pick<PluginOwnFields<T>, NonFunctionPropertyNames<PluginOwnFields<T>>>
> &
	Record<string, unknown>

export type CoreHostConfigHandle<TTarget extends PluginConstructor> = {
	readonly owner: PluginNodeAddressSnapshot
	set: (patch: CoreHostConfigPatch<TTarget>) => void
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
	restart(id: PluginIdentifier, opts?: { cascadeDependents?: boolean }): CoreHost
	replace(
		id: PluginIdentifier,
		next: PluginConstructor,
		opts?: { cascadeDependents?: boolean; provideBase?: boolean },
	): CoreHost
	fork<T extends ForkablePluginConstructor>(
		Plugin: T,
		forkId: string,
		opts?: { provideBase?: boolean },
	): T
	commit(): Promise<CommitSummary>
	commitAllowFail(): Promise<CommitSummary>
	isRunning(id: PluginIdentifier): boolean
	get<T extends PluginIdentifier>(id: T): InstanceType<T> | undefined
	require<T extends PluginIdentifier>(id: T): InstanceType<T>
	cfg<T extends PluginConstructor>(target: T): CoreHostConfigHandle<T>
	start<T extends PluginConstructor>(
		Plugin: T,
		opts?: { provideBase?: boolean },
	): Promise<InstanceType<T>>
	last(): CommitSummary | undefined
	services(): PluginNodeSlot[]
	plugins(): PluginConstructor[]
	has(id: PluginIdentifier | PluginNodeSlot): boolean
	dispose(): Promise<void>
}

export type CoreTestContext = { readonly ctx: Context; dispose: () => Promise<void> }
export type CoreHostOptions = { prepareCommit?: (ctx: Context) => Promise<void> | void }

type RuntimeStateLike = {
	snapshot(): { enabled: readonly PluginNodeAddressSnapshot[] }
	update(run: (draft: { enabled: PluginNodeAddressSnapshot[] }) => void): void
}

function runtimeStateOf(ctx: Context): RuntimeStateLike | undefined {
	const value = (ctx as unknown as { runtimeState?: unknown }).runtimeState
	if (!value || typeof value !== 'object') return undefined
	const candidate = value as Partial<RuntimeStateLike>
	return typeof candidate.snapshot === 'function' && typeof candidate.update === 'function'
		? (candidate as RuntimeStateLike)
		: undefined
}

export type CoreHostLifecycleIssueExpectation = {
	phase?: PluginLifecycleIssuePhase
	kind?: PluginLifecycleIssueKind
	blockedBy?: PluginConstructor
	message?: string | RegExp
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

function nodeFor(summary: CommitSummary, target: PluginConstructor): PluginNodeSlot | undefined {
	const address = pluginNodeAddressOf(target)
	const candidates: unknown[] = [...summary.graph.keys()]
	for (const issue of summary.lifecycleReport.issues) {
		candidates.push(issue.plugin)
		if (issue.blockedBy) candidates.push(issue.blockedBy)
	}
	for (const node of candidates) {
		if (!node || typeof node !== 'object' || !('definition' in node)) continue
		const slot = node as PluginNodeSlot
		const entry = slot.definition.entry.address
		const current: PluginNodeAddressSnapshot =
			slot.instance === 'default'
				? { definition: { entry, exportName: slot.definition.exportName }, instance: 'default' }
				: {
						definition: { entry, exportName: slot.definition.exportName },
						instance: 'fork',
						forkId: slot.forkId!,
					}
		if (pluginNodeAddressEqual(current, address)) return slot
	}
	return undefined
}

export function findPluginLifecycleIssue(
	summary: CommitSummary,
	plugin: PluginConstructor,
	expected: CoreHostLifecycleIssueExpectation = {},
): PluginLifecycleIssue | undefined {
	const node = nodeFor(summary, plugin)
	const blockedBy = expected.blockedBy ? nodeFor(summary, expected.blockedBy) : undefined
	return summary.lifecycleReport.issues.find((issue) => {
		if (issue.plugin !== node) return false
		if (expected.phase && issue.phase !== expected.phase) return false
		if (expected.kind && issue.kind !== expected.kind) return false
		if (blockedBy && issue.blockedBy !== blockedBy) return false
		if (expected.message instanceof RegExp) return expected.message.test(issue.message)
		if (typeof expected.message === 'string') return issue.message.includes(expected.message)
		return true
	})
}

export function pluginLifecycleIssuePlugins(
	summary: CommitSummary,
	expected: CoreHostLifecycleIssueExpectation = {},
): PluginNodeSlot[] {
	const blockedBy = expected.blockedBy ? nodeFor(summary, expected.blockedBy) : undefined
	return [
		...new Set(
			summary.lifecycleReport.issues
				.filter((issue) => {
					if (expected.phase && issue.phase !== expected.phase) return false
					if (expected.kind && issue.kind !== expected.kind) return false
					if (blockedBy && issue.blockedBy !== blockedBy) return false
					if (expected.message instanceof RegExp && !expected.message.test(issue.message))
						return false
					return typeof expected.message !== 'string' || issue.message.includes(expected.message)
				})
				.map((issue) => issue.plugin),
		),
	]
}

export function assertPluginLifecycleIssue(
	summary: CommitSummary,
	plugin: PluginConstructor,
	expected: CoreHostLifecycleIssueExpectation = {},
): PluginLifecycleIssue {
	const issue = findPluginLifecycleIssue(summary, plugin, expected)
	if (issue) return issue
	throw new Error(
		`Expected lifecycle issue for ${pluginNodeAddressOf(plugin).definition.exportName}`,
	)
}

export function createCoreHost(
	config: Context.Config = {},
	options: CoreHostOptions = {},
): CoreHost {
	let host!: CoreHost
	const ctx = new Context({ name: 'test', ...normalizeConfig(config) })
	const registry = ctx.registry as PluginService
	const configService = ctx.configService
	const localEnabled: PluginNodeAddressSnapshot[] = []

	const setEnabled = (owner: PluginNodeAddressSnapshot, enabled: boolean) => {
		const runtimeState = runtimeStateOf(ctx)
		const mutate = (list: PluginNodeAddressSnapshot[]) => {
			const index = list.findIndex((item) => pluginNodeAddressEqual(item, owner))
			if (enabled && index < 0) list.push(owner)
			else if (!enabled && index >= 0) list.splice(index, 1)
		}
		if (runtimeState) runtimeState.update((draft) => mutate(draft.enabled))
		else mutate(localEnabled)
	}
	const isEnabled = (owner: PluginNodeAddressSnapshot) =>
		(runtimeStateOf(ctx)?.snapshot().enabled ?? localEnabled).some((item) =>
			pluginNodeAddressEqual(item, owner),
		)

	const last = () => registry.lastCommit
	const services = () => [...(last()?.graph.keys() ?? [])] as PluginNodeSlot[]
	const plugins = () =>
		(last()?.graph.declarationsBySlot() ?? [])
			.map((decl) => decl?.meta?.class)
			.filter(
				(value): value is PluginConstructor =>
					typeof value === 'function' && checkPluginDecorator(value),
			)
	const has = (id: PluginIdentifier | PluginNodeSlot) =>
		registry.resolvePluginNode(id) !== undefined
	const get = <T extends PluginIdentifier>(id: T) => registry.getInstance(id)
	const require = <T extends PluginIdentifier>(id: T) => {
		const instance = get(id)
		if (!instance) throw new Error('Plugin instance is not running')
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

	function add(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): CoreHost
	function add(Plugins: readonly PluginConstructor[], opts?: { provideBase?: boolean }): CoreHost
	function add(
		value: PluginConstructor | readonly PluginConstructor[],
		opts?: { provideBase?: boolean },
	): CoreHost {
		if (typeof value === 'function') registry.register(value, opts)
		else for (const Plugin of value) registry.register(Plugin, opts)
		return host
	}
	function remove(id: PluginIdentifier): CoreHost
	function remove(ids: readonly PluginIdentifier[]): CoreHost
	function remove(value: PluginIdentifier | readonly PluginIdentifier[]): CoreHost {
		if (Array.isArray(value)) for (const id of value) registry.unregister(id)
		else registry.unregister(value as PluginIdentifier)
		return host
	}

	host = {
		ctx,
		add,
		remove,
		restart: (id, opts) => (registry.restart(id, opts), host),
		replace: (id, next, opts) => (registry.replace(id, next, opts), host),
		fork: (Plugin, forkId, opts) => registry.registerFork(Plugin, forkId, opts) as typeof Plugin,
		commit,
		commitAllowFail,
		isRunning: registry.isRunning.bind(registry),
		get,
		require,
		cfg: (<T extends PluginConstructor>(Plugin: T): CoreHostConfigHandle<T> => {
			const owner = pluginNodeAddressOf(Plugin)
			const slot = registry.internNodeAddress(owner)
			return {
				owner,
				set: (patch) => configService.patchConfig(slot, patch),
				unset: (...keys) => configService.unsetConfigKeys(slot, keys),
				rev: () => configService.getConfigRevision(slot),
				enable: () => setEnabled(owner, true),
				disable: () => setEnabled(owner, false),
				enabled: () => isEnabled(owner),
			}
		}) as CoreHost['cfg'],
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
				for (const Plugin of plugins()) registry.unregister(Plugin)
				if (last()) await host.commitAllowFail().catch((): undefined => undefined)
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
			ctx.registry.resetDraft()
			await ctx.effects.dispose().catch((): undefined => undefined)
			ctx.registry.resetDraft()
		},
	}
}

export async function withCoreContext<T>(
	fn: (ctx: Context) => Promise<T> | T,
	config: Context.Config = {},
): Promise<T> {
	const value = createCoreContext(config)
	try {
		return await fn(value.ctx)
	} finally {
		await value.dispose()
	}
}
