// PluginContainer.ts

import type { Context } from '@pluxel/context'
import { createErr, createOk, unwrapOk } from 'option-t/plain_result'
import { type DiodContainer, ExtendedContainerBuilder } from '../container'
import { BasePlugin, FORK_CTX, PLUGIN_CTX } from './BasePlugin'
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

		this.builder
			.register(baseOrSelf as any)
			.useFactory((c) => {
				const pluginCTX = this.createPluginContext()
				pluginCTX.pluginInfo = info

				// 按“实例”固化 ctx；闭包 + 复用一个描述符，避免每个依赖分配 {value:...}
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
						desc.value = null // 保险起见，打断 descriptor 对 view 的引用
						return injected
					}
				})()

				const prevFork = BasePlugin[FORK_CTX]
				BasePlugin[FORK_CTX] = () => pluginCTX
				try {
					switch (depsCount) {
						case 0:
							return new (Plugin as any)()
						case 1:
							return new (Plugin as any)(wrap(unwrapOk(c.getResult(paramTypes[0]))!))
						case 2:
							return new (Plugin as any)(
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
							// 只有 4+ 依赖时才分配数组
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
