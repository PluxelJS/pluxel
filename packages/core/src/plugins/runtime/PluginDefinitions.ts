import type { Context } from '@pluxel/context'
import {
	DraftGraph,
	factoryProvider,
	type GraphBuildError,
	type GraphDelta,
	type GraphSnapshot,
	Runtime,
	type Token,
} from '../../internal/di'
import { createErr, createOk } from 'option-t/plain_result'
import { BasePlugin } from '../composition/BasePlugin'
import { CALLER_CONTEXT_BIND, FORK_CTX, PLUGIN_CTX } from '../composition/symbols'
import { createPluginInfo } from '../decorators/PluginDecorator'
import type { PluginInfo } from '../decorators/decorator/types'
import type { PluginConstructor, PluginIdentifier, PluginInstance } from '../types'
import { getPluginDefinitionFacts } from './definition'
import { getForkId } from './fork-identity'
import {
	isPluginNodeSlot,
	PluginSlotRegistry,
	type PluginDefinitionSlot,
	type PluginNodeSlot,
} from './identity'

export type PluginGraph = GraphSnapshot<PluginInfo>
export type PluginRuntime = Runtime<PluginInfo>
export type createCTX = () => Context

export type PluginDependencyOverride = PluginDefinitionSlot | PluginNodeSlot | undefined
type PluginDependencyOverrideResolver = (
	node: PluginNodeSlot,
) => readonly PluginDependencyOverride[] | undefined

type PluginGraphDelta = Omit<GraphDelta, 'added' | 'removed' | 'replaced' | 'affected'> & {
	readonly added: readonly PluginNodeSlot[]
	readonly removed: readonly PluginNodeSlot[]
	readonly replaced: readonly { from: PluginNodeSlot; to: PluginNodeSlot }[]
	readonly affected: readonly PluginNodeSlot[]
}

type BuildRet = {
	graph: PluginGraph
	runtime: PluginRuntime
	delta: PluginGraphDelta
	confirm: () => void
}

function uniqueTokens(tokens: Iterable<Token>): Token[] {
	const out: Token[] = []
	const seen = new Set<Token>()
	for (const token of tokens) {
		if (seen.has(token)) continue
		seen.add(token)
		out.push(token)
	}
	return out
}

export class PluginDefinitions {
	private readonly draft = new DraftGraph<PluginInfo>()
	private committedRuntime?: PluginRuntime
	readonly slots = new PluginSlotRegistry()

	constructor(
		private readonly createPluginContext: createCTX,
		private readonly options: {
			resolveDependencyOverrides?: PluginDependencyOverrideResolver
		} = {},
	) {}

	get lastGraph(): PluginGraph {
		return this.draft.graph
	}

	hasPendingChanges(): boolean {
		return this.draft.hasPendingChanges()
	}

	get runtime(): PluginRuntime {
		const graph = this.lastGraph
		if (this.committedRuntime?.graph === graph) return this.committedRuntime
		return (this.committedRuntime = new Runtime(graph, this.draft.instances))
	}

	definitionSlot(Plugin: PluginIdentifier): PluginDefinitionSlot {
		return this.slots.internDefinition(getPluginDefinitionFacts(Plugin).definition)
	}

	nodeSlot(Plugin: PluginConstructor): PluginNodeSlot {
		const definition = this.definitionSlot(Plugin)
		const forkId = getForkId(Plugin)
		return forkId ? this.slots.forkNode(definition, forkId) : this.slots.defaultNode(definition)
	}

	resolvePlanningHandle(handle: PluginIdentifier | PluginNodeSlot): PluginNodeSlot | undefined {
		if (isPluginNodeSlot(handle)) return this.draft.has(handle) ? handle : undefined
		const facts = getPluginDefinitionFacts(handle)
		const definition = this.slots.internDefinition(facts.definition)
		if (facts.kind === 'abstract') {
			const resolved = this.draft.resolvePlanningToken(definition)
			return isPluginNodeSlot(resolved) ? resolved : undefined
		}
		const node = this.nodeSlot(handle as PluginConstructor)
		return this.draft.has(node) ? node : undefined
	}

	collectPlanningCascadeTargets(handle: PluginIdentifier | PluginNodeSlot): Set<PluginNodeSlot> {
		const token = isPluginNodeSlot(handle) ? handle : this.definitionSlot(handle)
		return this.draft.collectCascadeTargets(token) as Set<PluginNodeSlot>
	}

	resetDraft(): void {
		this.draft.reset()
	}

	isRegistered(handle: PluginIdentifier | PluginNodeSlot): boolean {
		return this.resolvePlanningHandle(handle) !== undefined
	}

	planningDeclaration(node: PluginNodeSlot) {
		return this.draft.planningDeclaration(node)
	}

	register(Plugin: PluginConstructor, opts?: { provideBase?: boolean }): PluginNodeSlot {
		const decl = this.createProviderDecl(Plugin, opts)
		this.draft.put(decl)
		return decl.key as PluginNodeSlot
	}

	replace(target: PluginNodeSlot, next: PluginConstructor, opts?: { provideBase?: boolean }): void {
		const decl = this.createProviderDecl(next, opts)
		if (decl.key !== target) {
			throw new Error('[pluxel/core] Plugin replacement must preserve its definition/node slot')
		}
		this.draft.replace(target, decl)
	}

	unregister(node: PluginNodeSlot): void {
		this.draft.remove(node)
	}

	callerView(parent: BasePlugin, pluginCTX: Context): BasePlugin {
		const callerView = Object.create(parent[PLUGIN_CTX]) as Context
		callerView.caller = pluginCTX
		const target = Object.create(parent, {
			ctx: { value: callerView, writable: false, enumerable: false, configurable: false },
		}) as BasePlugin
		return new Proxy(target, {
			get(current, property, receiver) {
				const value = Reflect.get(current, property, receiver) as unknown
				if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value
				const bind = (value as { [CALLER_CONTEXT_BIND]?: (caller: Context) => unknown })[
					CALLER_CONTEXT_BIND
				]
				return typeof bind === 'function' ? bind.call(value, pluginCTX) : value
			},
		})
	}

	private createCallerViewFactory(pluginCTX: Context): (parent: BasePlugin) => BasePlugin {
		return (parent) => this.callerView(parent, pluginCTX)
	}

	private instantiatePlugin(
		Plugin: PluginConstructor,
		deps: readonly unknown[],
		wrapParent: (parent: BasePlugin) => BasePlugin,
	): PluginInstance {
		const args = deps.map((dep) => wrapParent(dep as BasePlugin))
		return new Plugin(...args)
	}

	private instantiatePluginInContext(
		Plugin: PluginConstructor,
		info: PluginInfo,
		deps: readonly unknown[],
	): PluginInstance {
		const pluginCTX = this.createPluginContext()
		pluginCTX.pluginInfo = info
		const prevFork = BasePlugin[FORK_CTX]
		BasePlugin[FORK_CTX] = () => pluginCTX
		try {
			return this.instantiatePlugin(Plugin, deps, this.createCallerViewFactory(pluginCTX))
		} finally {
			BasePlugin[FORK_CTX] = prevFork
		}
	}

	private createProviderDecl(Plugin: PluginConstructor, opts?: { provideBase?: boolean }) {
		const info = createPluginInfo(Plugin, this.slots)
		const facts = getPluginDefinitionFacts(Plugin)
		const required = facts.requires.map((address) => this.slots.internDefinition(address))
		const overrides = this.options.resolveDependencyOverrides?.(info.nodeSlot)
		const deps = required.map((slot, index) => overrides?.[index] ?? slot)
		const optionalDeps = facts.optional.map((address) => this.slots.internDefinition(address))
		const isFork = getForkId(Plugin) !== undefined
		const provideAbstract = facts.provides && (opts?.provideBase ?? !isFork)
		const tokens = uniqueTokens([
			...(!isFork ? [info.definitionSlot] : []),
			...(provideAbstract ? [this.slots.internDefinition(facts.provides!)] : []),
		])

		return factoryProvider<PluginInstance, PluginInfo>({
			key: info.nodeSlot,
			tokens,
			deps,
			optionalDeps,
			meta: info,
			use: (...resolvedDeps) => this.instantiatePluginInContext(Plugin, info, resolvedDeps),
		})
	}

	build() {
		const built = this.draft.build()
		if (built.ok === false) {
			return createErr({ err: built.err as GraphBuildError, reset: () => this.draft.reset() })
		}
		assertPluginGraphDelta(built.val.delta)
		const ret: BuildRet = {
			graph: built.val.graph,
			runtime: built.val.runtime,
			delta: built.val.delta,
			confirm: () => void built.val.commit(),
		}
		return createOk(ret)
	}
}

function assertPluginGraphDelta(delta: GraphDelta): asserts delta is PluginGraphDelta {
	for (const key of delta.added) assertNode(key)
	for (const key of delta.removed) assertNode(key)
	for (const key of delta.affected) assertNode(key)
	for (const replacement of delta.replaced) {
		assertNode(replacement.from)
		assertNode(replacement.to)
	}
}

function assertNode(value: unknown): asserts value is PluginNodeSlot {
	if (!isPluginNodeSlot(value))
		throw new TypeError('[pluxel/core] Plugin graph produced a non-slot key')
}
