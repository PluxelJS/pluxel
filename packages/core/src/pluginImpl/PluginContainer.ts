// PluginContainer.ts

import type { Context } from '@pluxel/context'
import { createErr, createOk, unwrapOk } from 'option-t/plain_result'
import { type DiodContainer, ExtendedContainerBuilder } from '../container'
import { BasePlugin, FORK_CTX } from './BasePlugin'
import { getClassParam, getPluginInfo } from './PluginDecorator'
import type { PluginConstructor, PluginIdentifier, PluginInstance } from './types'

export type PluginDiContainer = DiodContainer<BasePlugin>
export type createCTX = () => Context
export class PluginContainer {
	/** Builder_Singleton 实例缓存（ExtendedContainerBuilder 共享） */
	public singletons = new Map<PluginIdentifier, PluginInstance>()
	private builder = new ExtendedContainerBuilder(this.singletons)

	constructor(private createPluginContext: createCTX) {}

	public lastContainer!: PluginDiContainer
	/**
	 * Factory 仅构造实例并挂载 ctx，不在此触发生命周期
	 * 所有依赖在构造阶段视为必需，缺失将立即抛错
	 */
	public registerPlugin(Plugin: PluginConstructor): void {
		const info = getPluginInfo(Plugin)
		if (!info) throw new Error('缺少 @Plugin 装饰器元数据')

		const paramTypes = getClassParam(Plugin) as PluginIdentifier[]
		const depsCount = paramTypes.length
		const baseOrSelf = info.base ?? Plugin

		// ---------- 影子包装：仅遮蔽 ctx，不改 parent 本体 ----------
		const wrapWithCaller = (parent: BasePlugin, pluginCTX: any): BasePlugin => {
			// 1) ctx 影子层（只添加 caller，不破坏 parent.ctx）
			const ctxView = Object.create(parent.ctx)
			ctxView.caller = pluginCTX

			// 2) plugin 影子层：复用 parent 的所有行为，仅用“自有属性”覆盖 ctx
			const injected = Object.create(parent, {
				ctx: { value: ctxView }, // writable/configurable/enumerable 默认为 false
			})
			return injected
		}

		this.builder
			.register(baseOrSelf as any)
			.useFactory((c) => {
				const pluginCTX = this.createPluginContext()

				const instantiate = <T>(factory: () => T): T => {
					const prevFork = BasePlugin[FORK_CTX]
					BasePlugin[FORK_CTX] = () => pluginCTX
					try {
						return factory()
					} finally {
						BasePlugin[FORK_CTX] = prevFork
					}
				}

				// —— 无参快路径 —— //
				if (depsCount === 0) return instantiate(() => new Plugin())

				switch (depsCount) {
					case 1: {
						const dep0 = unwrapOk(c.getResult(paramTypes[0]))!
						return instantiate(() => new (Plugin as any)(wrapWithCaller(dep0, pluginCTX)))
					}
					case 2: {
						const dep0 = unwrapOk(c.getResult(paramTypes[0]))!
						const dep1 = unwrapOk(c.getResult(paramTypes[1]))!
						return instantiate(
							() =>
								new (Plugin as any)(
									wrapWithCaller(dep0, pluginCTX),
									wrapWithCaller(dep1, pluginCTX),
								),
						)
					}
					case 3: {
						const dep0 = unwrapOk(c.getResult(paramTypes[0]))!
						const dep1 = unwrapOk(c.getResult(paramTypes[1]))!
						const dep2 = unwrapOk(c.getResult(paramTypes[2]))!
						return instantiate(
							() =>
								new (Plugin as any)(
									wrapWithCaller(dep0, pluginCTX),
									wrapWithCaller(dep1, pluginCTX),
									wrapWithCaller(dep2, pluginCTX),
								),
						)
					}
					default: {
						const args = new Array<BasePlugin>(depsCount)
						for (let i = 0; i < depsCount; i++) {
							const parent = unwrapOk(c.getResult(paramTypes[i]))!
							args[i] = wrapWithCaller(parent, pluginCTX)
						}
						return instantiate(() => new (Plugin as any)(...args))
					}
				}
			})
			.withDependencies(depsCount === 0 ? [] : (paramTypes as PluginIdentifier[]))
			.asBuilderSingleton()
	}

	/**
	 * 卸载：深度优先仅修改草稿；实际停机在 PluginService.commit() 中统一执行
	 */
	public unregisterPlugin(plugin: PluginIdentifier): void {
		const children = this.lastContainer?.dependents.get(plugin) ?? new Set<PluginIdentifier>()
		for (const dep of children) this.unregisterPlugin(dep)
		this.builder.tryUnregister(plugin)
	}

	/**
	 * 热重载：清理受影响 id 的 Builder_Singleton 缓存；root 可替换新类
	 * 实际启停仍在 PluginService.commit()
	 */
	public reloadPlugin(root: PluginIdentifier, newClass?: PluginConstructor): void {
		if (!this.builder.buildables.has(root)) {
			throw new Error('You can not reload an unloaded Plugin.')
		}

		const depsMap = new Map<PluginIdentifier, Set<PluginIdentifier>>(this.lastContainer?.dependents)

		const affected = new Set<PluginIdentifier>()
		const collect = (id: PluginIdentifier) => {
			if (affected.has(id)) return
			affected.add(id)
			for (const child of depsMap.get(id) ?? []) collect(child)
		}
		collect(root)

		for (const id of affected) this.singletons.delete(id as any)

		for (const id of affected) {
			if (id === root && newClass) this.registerPlugin(newClass)
			else this.builder.dispatchReload(id)
		}
	}

	/**
	 * 构建草稿：返回 {container, confirm, undo, changes}
	 * 仅在调用 confirm() 时切换 lastContainer
	 */
	public build() {
		const builder = this.builder

		const ret: {
			container: PluginDiContainer
			confirm: () => void
			undo: () => ReturnType<typeof builder.buildables.reset>
			changes: ReturnType<typeof builder.buildables.commit>
		} = {
			container: this.lastContainer,
			confirm: () => {},
			changes: [],
			undo: () => builder.buildables.reset(),
		}

		if (builder.buildables.pendingOps.length === 0 && this.lastContainer) {
			return createOk(ret)
		}

		ret.changes = builder.buildables.commit()
		const result = builder.build()
		if (result.err) return createErr({ err: result.err, ret })

		ret.container = result.val as DiodContainer<BasePlugin>
		ret.confirm = () => {
			this.lastContainer = result.val as DiodContainer<BasePlugin>
		}
		return createOk(ret)
	}
}
