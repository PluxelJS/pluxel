// PluginDefinitions.ts
// Graph declaration layer around @pluxel/core-di with draft/commit semantics.
//
// Responsibilities:
// - register/unregister plugin ctors into the draft graph
// - build/verify a graph snapshot from the current draft
// - provide confirm/resetDraft helpers for orchestrators (HMR/PluginService)
//
// Non-responsibilities:
// - plugin lifecycles (start/stop/restart) -> PluginService
// - runtime instance cache mutation policy -> PluginService

import type { Context } from '@pluxel/context'
import {
	DraftGraph,
	factoryProvider,
	type GraphBuildError,
	type GraphDelta,
	type ProviderDecl,
	type GraphSnapshot,
	Runtime,
	type Token,
} from '@pluxel/core-di'
import { createErr, createOk } from 'option-t/plain_result'
import { getForkOf } from './fork'
import { BasePlugin } from '../composition/BasePlugin'
import { FORK_CTX, PLUGIN_CTX } from '../composition/symbols'
import {
	getClassParams,
	getPluginInfo,
	getRequiredPluginDependencies,
} from '../decorators/PluginDecorator'
import type { PluginConstructor, PluginIdentifier, PluginInstance } from '../types'
import {
	runtimePluginKeyOfCtor,
	type RuntimePluginHandle,
	type RuntimePluginKey,
} from './identity'

export type PluginGraph = GraphSnapshot<ReturnType<typeof getPluginInfo>>
export type PluginRuntime = Runtime<ReturnType<typeof getPluginInfo>>
export type createCTX = () => Context
type PluginDependencyTokenResolver = (token: PluginIdentifier) => RuntimePluginKey | undefined
type PluginDependencyTokenOverrideResolver = (
	pluginId: string,
) => readonly (PluginIdentifier | undefined)[] | undefined

type BuildRet = {
	graph: PluginGraph
	runtime: PluginRuntime
	delta: GraphDelta
	confirm: () => void
}

const uniqueTokens = (tokens: Iterable<Token>): Token[] => {
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
	private readonly draft = new DraftGraph<ReturnType<typeof getPluginInfo>>()
	private committedRuntime?: PluginRuntime

	constructor(
		private readonly createPluginContext: createCTX,
		private readonly options: {
			resolveDependencyToken?: PluginDependencyTokenResolver
			resolveDependencyTokenOverrides?: PluginDependencyTokenOverrideResolver
		} = {},
	) {}

	public get lastGraph(): PluginGraph {
		return this.draft.graph as PluginGraph
	}

	public hasPendingChanges(): boolean {
		return this.draft.hasPendingChanges()
	}

	public get runtime(): PluginRuntime {
		const graph = this.lastGraph
		if (this.committedRuntime?.graph === graph) return this.committedRuntime
		const runtime = new Runtime(graph, this.draft.instances) as PluginRuntime
		this.committedRuntime = runtime
		return runtime
	}

	public resolvePlanningHandle(id: RuntimePluginHandle): RuntimePluginKey | undefined {
		if (typeof id === 'string') return this.draft.has(id) ? id : undefined
		try {
			const key = runtimePluginKeyOfCtor(id)
			if (this.draft.has(key)) return key
			const resolvedByKey = this.draft.resolvePlanningToken(key) as RuntimePluginKey | undefined
			if (resolvedByKey) return resolvedByKey
		} catch {
			// Undecorated abstract/base tokens are resolved through graph aliases.
		}
		return this.draft.resolvePlanningToken(id) as RuntimePluginKey | undefined
	}

	public collectPlanningCascadeTargets(id: RuntimePluginHandle): Set<RuntimePluginKey> {
		const key = this.resolvePlanningHandle(id)
		return this.draft.collectCascadeTargets(key ?? id) as Set<RuntimePluginKey>
	}

	/** Roll back draft mutations since the last confirmed graph. */
	public resetDraft(): void {
		this.draft.reset()
	}

	/** Whether a plugin ctor is currently registered in the draft graph. */
	public isRegistered(id: RuntimePluginHandle): boolean {
		return this.resolvePlanningHandle(id) !== undefined
	}

	public register(
		Plugin: PluginConstructor,
		opts?: { provideBase?: boolean; aliases?: RuntimePluginHandle[] },
	): void {
		this.draft.put(this.createProviderDecl(Plugin, opts))
	}

	public replace(
		target: RuntimePluginHandle,
		next: PluginConstructor,
		opts?: { provideBase?: boolean; aliases?: RuntimePluginHandle[] },
	): void {
		this.draft.replace(target, this.createProviderDecl(next, opts))
	}

	private assertRequiredConstructorDepsDeclared(
		Plugin: PluginConstructor,
		paramTypes: readonly PluginIdentifier[],
	): void {
		const required = getRequiredPluginDependencies(Plugin, { inherit: true })
		if (required.length === 0) return

		const declared = new Set<PluginIdentifier>()
		for (let i = 0; i < paramTypes.length; i++) declared.add(paramTypes[i]!)

		const missing: PluginIdentifier[] = []
		for (let i = 0; i < required.length; i++) {
			const dep = required[i]!
			if (!declared.has(dep)) missing.push(dep)
		}
		if (missing.length === 0) return

		throw new Error(
			[
				`Missing constructor dependencies for ${String(Plugin)}.`,
				`This plugin uses decorators that require: ${missing.map(String).join(', ')}`,
				'Declare them as constructor params and @Plugin({ dependencies: [...] }) before registering.',
			].join(' '),
		)
	}

	private providerTokens(
		Plugin: PluginConstructor,
		info: NonNullable<ReturnType<typeof getPluginInfo>>,
		opts?: { provideBase?: boolean; aliases?: RuntimePluginHandle[] },
	): Token[] {
		const isFork = !!getForkOf(Plugin)
		const provideBase = opts?.provideBase ?? (info.base ? !isFork : false)
		return uniqueTokens([
			...(provideBase && info.base ? [info.base as PluginIdentifier] : []),
			...(opts?.aliases ?? []),
		] as Token[])
	}

	private normalizeDependencyTokens(paramTypes: readonly PluginIdentifier[]): readonly Token[] {
		const resolveDependencyToken = this.options.resolveDependencyToken
		if (!resolveDependencyToken || paramTypes.length === 0) return paramTypes

		let next: Token[] | undefined
		for (let i = 0; i < paramTypes.length; i++) {
			const token = paramTypes[i]!
			const resolved = resolveDependencyToken(token)
			if (!resolved) continue
			if (!next) next = [...paramTypes]
			next[i] = resolved
		}
		return next ?? paramTypes
	}

	private createCallerViewFactory(pluginCTX: Context): (parent: BasePlugin) => BasePlugin {
		const ctxDescriptor: PropertyDescriptor = {
			value: null,
			writable: false,
			enumerable: false,
			configurable: false,
		}

		return (parent: BasePlugin): BasePlugin => {
			const callerView = Object.create(parent[PLUGIN_CTX])
			callerView.caller = pluginCTX
			ctxDescriptor.value = callerView
			const injected = Object.create(parent, { ctx: ctxDescriptor })
			ctxDescriptor.value = null
			return injected
		}
	}

	private instantiatePlugin(
		Plugin: PluginConstructor,
		deps: readonly unknown[],
		wrapParent: (parent: BasePlugin) => BasePlugin,
	): PluginInstance {
		switch (deps.length) {
			case 0:
				return new Plugin()
			case 1:
				return new Plugin(wrapParent(deps[0]! as BasePlugin))
			case 2:
				return new Plugin(wrapParent(deps[0]! as BasePlugin), wrapParent(deps[1]! as BasePlugin))
			case 3:
				return new Plugin(
					wrapParent(deps[0]! as BasePlugin),
					wrapParent(deps[1]! as BasePlugin),
					wrapParent(deps[2]! as BasePlugin),
				)
			default: {
				const args = Array<BasePlugin>(deps.length)
				for (let i = 0; i < deps.length; i++) args[i] = wrapParent(deps[i]! as BasePlugin)
				const Ctor = Plugin as new (...args: BasePlugin[]) => PluginInstance
				return new Ctor(...args)
			}
		}
	}

	private instantiatePluginInContext(
		Plugin: PluginConstructor,
		info: NonNullable<ReturnType<typeof getPluginInfo>>,
		deps: readonly unknown[],
	): PluginInstance {
		const pluginCTX = this.createPluginContext()
		pluginCTX.pluginInfo = info
		const wrapParent = this.createCallerViewFactory(pluginCTX)

		const prevFork = BasePlugin[FORK_CTX]
		BasePlugin[FORK_CTX] = () => pluginCTX
		try {
			return this.instantiatePlugin(Plugin, deps, wrapParent)
		} finally {
			BasePlugin[FORK_CTX] = prevFork
		}
	}

	private createProviderDecl(
		Plugin: PluginConstructor,
		opts?: { provideBase?: boolean; aliases?: RuntimePluginHandle[] },
	): ProviderDecl<PluginInstance, ReturnType<typeof getPluginInfo>> {
		const info = getPluginInfo(Plugin)
		if (!info) throw new Error('缺少 @Plugin 装饰器元数据')

		const paramTypes = getClassParams(
			Plugin,
			this.options.resolveDependencyTokenOverrides?.(info.id),
		) as PluginIdentifier[]
		this.assertRequiredConstructorDepsDeclared(Plugin, paramTypes)
		const deps = this.normalizeDependencyTokens(paramTypes)
		const extraTokens = this.providerTokens(Plugin, info, opts)

		return factoryProvider({
			key: runtimePluginKeyOfCtor(Plugin),
			tokens: extraTokens,
			deps,
			meta: info,
			use: (...resolvedDeps: readonly unknown[]) =>
				this.instantiatePluginInContext(Plugin, info, resolvedDeps),
		})
	}

	public unregister(id: RuntimePluginHandle): void {
		this.draft.remove(id)
	}

	public build() {
		const built = this.draft.build()
		if ('err' in built) {
			const reset = () => this.draft.reset()
			return createErr({ err: built.err as GraphBuildError, reset })
		}

		const ret: BuildRet = {
			graph: built.val.graph as PluginGraph,
			runtime: built.val.runtime as PluginRuntime,
			delta: built.val.delta,
			confirm: () => {
				built.val.commit()
			},
		}

		return createOk(ret)
	}
}
