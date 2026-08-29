import './services/index'
import { createCoreRootContext } from './context/core-plan'
import type { CoreHostConfig, RootContext } from './context/Context'
import {
	BasePlugin,
	pluginDefinitionAddressEqual,
	pluginNodeAddressEqual,
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
	type CommitSummary,
	type PluginConstructor,
	type PluginDefinitionAddress,
	type PluginLifecycleIssue,
	type PluginLifecycleIssueKind,
	type PluginLifecycleIssuePhase,
	type PluginNodeAddress,
	type PluginNodeSlot,
	type PluginPart,
} from './index'
import { checkPluginDecorator } from './plugins/decorators/decorator/api'
import { requireConfigService } from './internal/config-service'
import { requirePluginService } from './internal/plugin-service'
import { consumePluginDefinitionCandidate } from './plugins/runtime/definition'
import { parsePluginNodeAddress } from './plugins/runtime/identity'
import { assertCommitStarted, type PluginService } from './plugins/runtime/PluginService'
import type { PreparedRuntimeUpdateCommitOptions } from './plugins/runtime/plugin-service/RuntimeUpdateTransaction'

export {
	BasePlugin,
	Plugin,
	PluginPart,
	collectPluginLifecycleBlocked,
	collectPluginLifecycleDrainErrors,
	collectPluginLifecycleIssuePlugins,
	collectPluginLifecycleNotStarted,
	definePluginRef,
	isPluginLifecycleBlockedIssue,
	isPluginLifecycleDrainErrorIssue,
	isPluginLifecycleNotStartedIssue,
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
} from './index'
export { checkPluginDecorator }
export type {
	CommitSummary,
	PluginCommitChanges,
	PluginDefinitionAddress,
	PluginLifecycleIssue,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
	PluginLifecycleIssuePredicate,
	PluginNodeAddress,
	PluginNodeSlot,
	PluginRef,
	PluginReplacement,
	PluginConstructor,
	RuntimeUpdateCommitSummary,
} from './index'

declare const pluginNodeType: unique symbol

/** Type-only author hint; the runtime value is exactly a frozen PluginNodeAddress. */
export type PluginNodeHandle<T extends PluginConstructor> = PluginNodeAddress &
	Readonly<{ [pluginNodeType]: T }>

type NonFunctionPropertyNames<T extends object> = {
	[K in keyof T]-?: T[K] extends (...args: any[]) => any ? never : K
}[keyof T]

type PluginOwnFields<T extends PluginConstructor> = Omit<InstanceType<T>, keyof BasePlugin>
type PluginConfigFieldValue<T> = T extends PluginPart<any, any> ? Record<string, unknown> : T

export type CoreHostConfigPatch<T extends PluginConstructor> = Partial<{
	[K in NonFunctionPropertyNames<PluginOwnFields<T>>]: PluginConfigFieldValue<PluginOwnFields<T>[K]>
}> &
	Record<string, unknown>

export type CoreHostConfigHandle<TTarget extends PluginConstructor> = {
	readonly owner: PluginNodeAddress
	set(patch: CoreHostConfigPatch<TTarget>): void
	unset(...keys: string[]): void
	rev(): number
}

type TypedTarget<T extends PluginConstructor> = T | PluginNodeHandle<T>
type AnyTarget = PluginConstructor | PluginNodeAddress

export interface CoreHost {
	readonly ctx: RootContext
	add(Plugin: PluginConstructor): CoreHost
	add(Plugins: readonly PluginConstructor[]): CoreHost
	remove(target: AnyTarget, options?: { cascadeDependents?: boolean }): CoreHost
	remove(targets: readonly AnyTarget[]): CoreHost
	restart(target: AnyTarget, options?: { cascadeDependents?: boolean }): CoreHost
	replace(
		target: AnyTarget,
		next: PluginConstructor,
		options?: { cascadeDependents?: boolean },
	): CoreHost
	fork<T extends PluginConstructor>(Plugin: T, forkId: string): PluginNodeHandle<T>
	override(
		consumer: AnyTarget,
		requirement: PluginConstructor | PluginDefinitionAddress,
		provider: PluginNodeAddress | null,
	): CoreHost
	commit(options?: PreparedRuntimeUpdateCommitOptions): Promise<CommitSummary>
	commitAllowFail(): Promise<CommitSummary>
	isRunning(target: AnyTarget): boolean
	get<T extends PluginConstructor>(target: TypedTarget<T>): InstanceType<T> | undefined
	get(target: PluginNodeAddress): BasePlugin | undefined
	require<T extends PluginConstructor>(target: TypedTarget<T>): InstanceType<T>
	require(target: PluginNodeAddress): BasePlugin
	cfg<T extends PluginConstructor>(target: TypedTarget<T>): CoreHostConfigHandle<T>
	start<T extends PluginConstructor>(Plugin: T): Promise<InstanceType<T>>
	last(): CommitSummary | undefined
	services(): PluginNodeSlot[]
	plugins(): PluginConstructor[]
	has(target: AnyTarget): boolean
	dispose(): Promise<void>
}

export type CoreTestContext = { readonly ctx: RootContext; dispose: () => Promise<void> }
export type CoreHostOptions = {
	prepareCommit?: (ctx: RootContext) => Promise<void> | void
	/** @internal Allows higher-level package tests to supply their explicit Context plan. */
	createRootContext?: (config: CoreHostConfig) => RootContext
}

export type CoreHostLifecycleIssueExpectation = {
	phase?: PluginLifecycleIssuePhase
	kind?: PluginLifecycleIssueKind
	blockedBy?: PluginConstructor | PluginNodeAddress
	message?: string | RegExp
}

function normalizeConfig(config: CoreHostConfig): CoreHostConfig {
	return { ...config }
}

function targetAddress(target: AnyTarget): PluginNodeAddress {
	return typeof target === 'function' ? pluginNodeAddressOf(target) : parsePluginNodeAddress(target)
}

function assertCommitResult(
	result: Awaited<ReturnType<ReturnType<PluginService['beginUpdate']>['commit']>>,
	registry: PluginService,
): CommitSummary {
	if (result.ok === false) {
		throw result.err instanceof Error ? result.err : new Error(String(result.err))
	}
	const summary = registry.lastCommit
	if (!summary) throw new Error('Core Plugin update committed without a CommitSummary')
	return summary
}

function nodeFor(summary: CommitSummary, target: AnyTarget): PluginNodeSlot | undefined {
	const address = targetAddress(target)
	const candidates: unknown[] = []
	for (const issue of summary.lifecycleReport.issues) {
		candidates.push(issue.plugin)
		if (issue.blockedBy) candidates.push(issue.blockedBy)
	}
	for (const node of candidates) {
		if (!node || typeof node !== 'object' || !('definition' in node)) continue
		const slot = node as PluginNodeSlot
		const current: PluginNodeAddress =
			slot.variant === 'default'
				? {
						definition: {
							entry: slot.definition.entry.address,
							exportName: slot.definition.exportName,
						},
						variant: 'default',
					}
				: {
						definition: {
							entry: slot.definition.entry.address,
							exportName: slot.definition.exportName,
						},
						variant: 'fork',
						forkId: slot.forkId,
					}
		if (pluginNodeAddressEqual(current, address)) return slot
	}
	return undefined
}

export function findPluginLifecycleIssue(
	summary: CommitSummary,
	plugin: AnyTarget,
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
	plugin: AnyTarget,
	expected: CoreHostLifecycleIssueExpectation = {},
): PluginLifecycleIssue {
	const issue = findPluginLifecycleIssue(summary, plugin, expected)
	if (issue) return issue
	throw new Error(`Expected lifecycle issue for ${targetAddress(plugin).definition.exportName}`)
}

export function createCoreHost(
	config: CoreHostConfig = {},
	options: CoreHostOptions = {},
): CoreHost {
	let host!: CoreHost
	const resolvedConfig = { name: 'test', ...normalizeConfig(config) }
	const ctx = options.createRootContext?.(resolvedConfig) ?? createCoreRootContext(resolvedConfig)
	const registry = requirePluginService(ctx)
	const configService = requireConfigService(ctx)
	let update: ReturnType<PluginService['beginUpdate']> | undefined

	const currentUpdate = () => (update ??= registry.beginUpdate({ reason: 'core-test' }))
	const candidateFor = (Plugin: PluginConstructor) => consumePluginDefinitionCandidate(Plugin)

	const addOne = (Plugin: PluginConstructor) => {
		currentUpdate().materializeNode(pluginNodeAddressOf(Plugin), candidateFor(Plugin))
	}
	function add(Plugin: PluginConstructor): CoreHost
	function add(Plugins: readonly PluginConstructor[]): CoreHost
	function add(value: PluginConstructor | readonly PluginConstructor[]): CoreHost {
		if (typeof value === 'function') addOne(value)
		else for (const Plugin of value) addOne(Plugin)
		return host
	}
	function remove(target: AnyTarget, options?: { cascadeDependents?: boolean }): CoreHost
	function remove(targets: readonly AnyTarget[]): CoreHost
	function remove(
		value: AnyTarget | readonly AnyTarget[],
		removeOptions?: { cascadeDependents?: boolean },
	): CoreHost {
		if (Array.isArray(value)) {
			for (const target of value) currentUpdate().dematerializeNode(targetAddress(target))
		} else currentUpdate().dematerializeNode(targetAddress(value as AnyTarget), removeOptions)
		return host
	}

	async function commit(
		allowFailure: boolean,
		commitOptions?: PreparedRuntimeUpdateCommitOptions,
	): Promise<CommitSummary> {
		await options.prepareCommit?.(ctx)
		const current = update ?? registry.beginUpdate({ reason: 'core-test-retry' })
		update = undefined
		try {
			const summary = assertCommitResult(await current.commit(commitOptions), registry)
			if (!allowFailure) assertCommitStarted(summary)
			return summary
		} catch (error) {
			current.rollback()
			throw error
		}
	}

	const get = (target: AnyTarget) => registry.getInstance(targetAddress(target))
	const requirePlugin = (target: AnyTarget) => {
		const instance = get(target)
		if (!instance) throw new Error('Plugin instance is not running')
		return instance
	}
	const plugins = () => {
		const implementations = new Set<PluginConstructor>()
		for (const node of registry.graph.keys()) {
			if (!isNodeSlot(node)) continue
			const declaration = registry.graph.declaration(node)
			if (declaration) implementations.add(declaration.meta!.definition.implementation)
		}
		return [...implementations]
	}

	host = {
		ctx,
		add,
		remove,
		restart: (target, restartOptions) => (
			currentUpdate().restartNode(targetAddress(target), restartOptions),
			host
		),
		replace: (target, next, replaceOptions) => {
			const address = targetAddress(target).definition
			const candidate = candidateFor(next)
			if (!pluginDefinitionAddressEqual(candidate.declaration.address, address)) {
				throw new TypeError(
					'CoreHost replacement must be lowered with the target Plugin definition address',
				)
			}
			currentUpdate().replaceDefinition(address, candidate, replaceOptions)
			return host
		},
		fork: (Plugin, forkId) => {
			const defaultAddress = pluginNodeAddressOf(Plugin)
			const address = parsePluginNodeAddress({
				definition: defaultAddress.definition,
				variant: 'fork',
				forkId,
			}) as PluginNodeHandle<typeof Plugin>
			currentUpdate().materializeNode(address, candidateFor(Plugin))
			return address
		},
		override: (consumer, requirement, provider) => {
			currentUpdate().setDependencyOverride(
				targetAddress(consumer),
				typeof requirement === 'function' ? pluginDefinitionAddressOf(requirement) : requirement,
				provider,
			)
			return host
		},
		commit: (commitOptions) => commit(false, commitOptions),
		commitAllowFail: () => commit(true),
		isRunning: (target) => registry.isRunning(targetAddress(target)),
		get: get as CoreHost['get'],
		require: requirePlugin as CoreHost['require'],
		cfg: (<T extends PluginConstructor>(target: TypedTarget<T>): CoreHostConfigHandle<T> => {
			const owner = targetAddress(target)
			return {
				owner,
				set: (patch) => configService.patchConfig(owner, patch),
				unset: (...keys) => configService.unsetConfigKeys(owner, keys),
				rev: () => configService.getConfigRevision(owner),
			}
		}) as CoreHost['cfg'],
		start: async (Plugin) => {
			host.add(Plugin)
			await host.commit()
			return host.require(Plugin)
		},
		last: () => registry.lastCommit,
		services: () => [...registry.graph.keys()] as PluginNodeSlot[],
		plugins,
		has: (target) => registry.resolvePluginNode(targetAddress(target)) !== undefined,
		dispose: async () => {
			try {
				update?.rollback()
				update = undefined
				const nodes = [...registry.graph.keys()].filter(isNodeSlot)
				if (nodes.length > 0) {
					const shutdown = registry.beginUpdate({ reason: 'core-test-dispose' })
					for (const node of nodes) {
						shutdown.dematerializeNode(registry.nodeAddressOf(node), {
							cascadeDependents: false,
						})
					}
					await shutdown.commit()
				}
			} finally {
				await ctx.effects.dispose().catch((): undefined => undefined)
			}
		},
	}
	return host
}

function isNodeSlot(value: unknown): value is PluginNodeSlot {
	return Boolean(value && typeof value === 'object' && 'definition' in value)
}

export async function withCoreHost<T>(
	fn: (host: CoreHost) => Promise<T> | T,
	config: CoreHostConfig = {},
	options: CoreHostOptions = {},
): Promise<T> {
	const host = createCoreHost(config, options)
	try {
		return await fn(host)
	} finally {
		await host.dispose()
	}
}

export function createCoreContext(
	config: CoreHostConfig = {},
	options: Pick<CoreHostOptions, 'createRootContext'> = {},
): CoreTestContext {
	const resolvedConfig = { name: 'test', ...normalizeConfig(config) }
	const ctx = options.createRootContext?.(resolvedConfig) ?? createCoreRootContext(resolvedConfig)
	return {
		ctx,
		dispose: async () => {
			requirePluginService(ctx).resetDraft()
			await ctx.effects.dispose().catch((): undefined => undefined)
		},
	}
}

export async function withCoreContext<T>(
	fn: (ctx: RootContext) => Promise<T> | T,
	config: CoreHostConfig = {},
): Promise<T> {
	const value = createCoreContext(config)
	try {
		return await fn(value.ctx)
	} finally {
		await value.dispose()
	}
}
