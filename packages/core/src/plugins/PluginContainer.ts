// PluginContainer.ts
// Thin DI adapter around diod with draft/commit semantics.
// It only creates plugin instances and wires ctx; lifecycles are managed
// by PluginService during commit().

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
export class PluginContainer {
	/** Builder_Singleton 实例缓存（ExtendedContainerBuilder 共享） */
	public singletons = new LeanMapTracker<PluginIdentifier, PluginInstance>()
	private builder = new ExtendedContainerBuilder(this.singletons)

	constructor(private createPluginContext: createCTX) {}

	public lastContainer!: PluginDiContainer

	/**
	 * Roll back draft mutations since the last confirmed container.
	 * This is primarily for upstream orchestrators (e.g. HMR) that want
	 * "all-or-nothing" batch application without forcing a build/commit attempt.
	 */
	public resetDraft(): void {
		this.builder.buildables.reset()
		this.singletons.reset()
	}

	/**
	 * Registration policy (deterministic + fast):
	 * - A plugin's DI key is always the ctor itself (including forks).
	 * - Abstract base/interface tokens are supported via DI aliases on the same registration.
	 *   (diod resolves aliases in getResult()/dependency resolution.)
	 */
	/**
	 * Factory 仅构造实例并挂载 ctx，不在此触发生命周期
	 * 所有依赖在构造阶段视为必需，缺失将立即抛错
	 */
	public registerPlugin(
		Plugin: PluginConstructor,
		opts?: { provideBase?: boolean },
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

		// Base/interface binding:
		// - Originals: default provideBase=true when a base is declared.
		// - Forks: default provideBase=false to avoid nondeterministic provider replacement.
		const isFork = !!getForkOf(Plugin)
		const provideBase =
			opts?.provideBase ?? (info.base ? !isFork : false)
		if (provideBase && info.base) {
			reg.addAlias(info.base as any)
		}
	}

	/**
	 * 卸载：深度优先仅修改草稿；实际停机在 PluginService.commit() 中统一执行
	 */
	public unregisterPlugin(plugin: PluginIdentifier): void {
		const container = this.lastContainer
		const resolve = (id: PluginIdentifier) =>
			(container?.resolveIdentifier?.(id as any) ?? id) as PluginIdentifier

		const root = resolve(plugin)
		const visited = new Set<PluginIdentifier>()
		const stack: Array<{ id: PluginIdentifier; expanded: boolean }> = [{ id: root, expanded: false }]

		while (stack.length) {
			const top = stack.pop()!
			if (top.expanded) {
				this.builder.tryUnregister(top.id)
				continue
			}

			if (visited.has(top.id)) continue
			visited.add(top.id)

			// Post-order: dependents first, then self.
			stack.push({ id: top.id, expanded: true })

			const children = container?.dependents.get(top.id)
			if (!children || children.size === 0) continue
			for (const dep of children) {
				const child = resolve(dep)
				if (!visited.has(child)) stack.push({ id: child, expanded: false })
			}
		}
	}

	/**
	 * 热重载：清理受影响 id 的 Builder_Singleton 缓存；root 可替换新类
	 * 实际启停仍在 PluginService.commit()
	 */
	public reloadPlugin(root: PluginIdentifier, newClass?: PluginConstructor): void {
		const canonicalRoot = (this.lastContainer?.resolveIdentifier?.(root as any) ?? root) as PluginIdentifier
		if (!this.builder.buildables.has(canonicalRoot)) {
			throw new Error('You can not reload an unloaded Plugin.')
		}

		const depsMap = new Map<PluginIdentifier, Set<PluginIdentifier>>(this.lastContainer?.dependents)

		const affected = new Set<PluginIdentifier>()
		const collect = (id: PluginIdentifier) => {
			if (affected.has(id)) return
			affected.add(id)
			for (const child of depsMap.get(id) ?? []) collect(child)
		}
		collect(canonicalRoot)

		for (const id of affected) this.singletons.delete(id as any)

		for (const id of affected) {
			if (id === canonicalRoot && newClass) this.registerPlugin(newClass)
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
			undo: () => void
			changes: ReturnType<typeof builder.buildables.commit>
		} = {
			container: this.lastContainer,
			confirm: () => {},
			changes: [],
			undo: () => {
				// Restore draft state when build/verification fails.
				// Both buildables and builder-singletons participate in draft mutations.
				builder.buildables.reset()
				this.singletons.reset()
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
			// Seal rollback baselines only after the container is confirmed.
			builder.buildables.seal()
			this.singletons.seal()
		}
		return createOk(ret)
	}
}
