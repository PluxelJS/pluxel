// PluginDefinitions.ts
// DI definition layer around diod with draft/commit semantics.
//
// Responsibilities:
// - register/unregister plugin ctors into the builder (declaration layer)
// - build/verify a Diod container from the current draft
// - provide confirm/resetDraft helpers for orchestrators (HMR/PluginService)
//
// Non-responsibilities:
// - plugin lifecycles (start/stop/restart) -> PluginService
// - runtime instance cache mutation -> PluginService (builderSingletons is owned there)

import type { Context } from '@pluxel/context'
import { createErr, createOk, unwrapOk } from 'option-t/plain_result'
import { type DiodContainer, ExtendedContainerBuilder } from '../container'
import { LeanMapTracker } from '../container/LeanMapTracker'
import { BasePlugin, FORK_CTX, PLUGIN_CTX } from './BasePlugin'
import { getForkOf } from './fork'
import { getClassParams, getPluginInfo } from './PluginDecorator'
import type { PluginConstructor, PluginIdentifier, PluginInstance } from './types'

export type PluginDiContainer = DiodContainer<BasePlugin>
export type createCTX = () => Context

type BuilderSingletons = LeanMapTracker<PluginIdentifier, PluginInstance>

export class PluginDefinitions {
	private readonly builder: ExtendedContainerBuilder

	constructor(
		private readonly createPluginContext: createCTX,
		private readonly builderSingletons: BuilderSingletons,
	) {
		this.builder = new ExtendedContainerBuilder(this.builderSingletons as any)

		// Ensure lastContainer is always defined so orchestrators can safely query graphs.
		const initial = this.builder.build()
		if (initial.ok) {
			this.lastContainer = initial.val as PluginDiContainer
			this.builder.buildables.seal()
			this.builderSingletons.seal()
		}
	}

	public lastContainer!: PluginDiContainer

	/** Roll back draft mutations since the last confirmed container. */
	public resetDraft(): void {
		this.builder.buildables.reset()
		this.builderSingletons.reset()
	}

	/** Whether a plugin ctor is currently registered in the draft builder. */
	public isRegistered(id: PluginIdentifier): boolean {
		return this.builder.isRegistered(id as any)
	}

	/**
	 * Registration policy (deterministic + fast):
	 * - A plugin's DI key is always the ctor itself (including forks).
	 * - Abstract base/interface tokens are supported via DI aliases on the same registration.
	 */
	public register(
		Plugin: PluginConstructor,
		opts?: { provideBase?: boolean; aliases?: PluginIdentifier[] },
	): void {
		const info = getPluginInfo(Plugin)
		if (!info) throw new Error('缺少 @Plugin 装饰器元数据')

		const paramTypes = getClassParams(Plugin) as PluginIdentifier[]
		const depsCount = paramTypes.length

		const reg = this.builder
			.register(Plugin)
			.useFactory((c) => {
				const pluginCTX = this.createPluginContext()
				pluginCTX.pluginInfo = info

				// Bind ctx onto the instance via a lightweight wrapper.
				const wrap = (() => {
					const desc: PropertyDescriptor = {
						value: null,
						writable: false,
						enumerable: false,
						configurable: false,
					}
					return (parent: BasePlugin): BasePlugin => {
						const view = Object.create(parent[PLUGIN_CTX])
						view.caller = pluginCTX
						desc.value = view
						const injected = Object.create(parent, { ctx: desc })
						desc.value = null
						return injected
					}
				})()

				const prevFork = BasePlugin[FORK_CTX]
				BasePlugin[FORK_CTX] = () => pluginCTX
				try {
					switch (depsCount) {
						case 0:
							return new (Plugin)()
						case 1:
							return new (Plugin)(wrap(unwrapOk(c.getResult(paramTypes[0]))!))
						case 2:
							return new (Plugin)(
								wrap(unwrapOk(c.getResult(paramTypes[0]))!),
								wrap(unwrapOk(c.getResult(paramTypes[1]))!),
							)
						case 3:
							return new (Plugin as any)(
								wrap(unwrapOk(c.getResult(paramTypes[0]))!),
								wrap(unwrapOk(c.getResult(paramTypes[1]))!),
								wrap(unwrapOk(c.getResult(paramTypes[2]))!),
							)
						default: {
							const args = new Array<BasePlugin>(depsCount)
							for (let i = 0; i < depsCount; i++) {
								args[i] = wrap(unwrapOk(c.getResult(paramTypes[i]))!)
							}
							return new (Plugin as any)(...args)
						}
					}
				} finally {
					BasePlugin[FORK_CTX] = prevFork
				}
			})
			.withDependencies(depsCount === 0 ? [] : (paramTypes as PluginIdentifier[]))
			.asBuilderSingleton()

		const isFork = !!getForkOf(Plugin)
		const provideBase = opts?.provideBase ?? (info.base ? !isFork : false)
		if (provideBase && info.base) reg.addAlias(info.base as any)

		for (const alias of opts?.aliases ?? []) reg.addAlias(alias as any)
	}

	/** Unregister a plugin ctor from the draft builder (no cascade). */
	public unregister(id: PluginIdentifier): void {
		const key = (this.lastContainer?.resolveIdentifier?.(id as any) ?? id) as PluginIdentifier
		this.builder.tryUnregister(key as any)
	}

	/**
	 * Build current draft and return {container, confirm, undo, changes}.
	 * Only confirm() switches lastContainer and seals draft baseline.
	 */
	public build() {
		const builder = this.builder

		const ret: {
			container: PluginDiContainer
			confirm: () => void
			undo: () => void
			changes: ReturnType<typeof builder.buildables.commit>
		} = {
			container: this.lastContainer,
			confirm: () => {},
			changes: [],
			undo: () => {
				builder.buildables.reset()
				this.builderSingletons.reset()
			},
		}

		if (builder.buildables.pendingOps.length === 0 && this.lastContainer) {
			return createOk(ret)
		}

		ret.changes = builder.buildables.commit()
		const result = builder.build()
		if (result.err) return createErr({ err: result.err, ret })

		const container = result.val as PluginDiContainer
		ret.container = container
		ret.confirm = () => {
			this.lastContainer = container
			builder.buildables.seal()
			this.builderSingletons.seal()
		}
		return createOk(ret)
	}
}
