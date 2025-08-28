// PluginContainer.ts
import type { Context } from '..'
import {
	type AliasKey,
	type DiodContainer,
	ExtendedContainerBuilder,
	type FactoryContext,
	// 下面两个类型用于重建别名索引
	type Identifier,
} from '../container'
import { type BasePlugin, PLUGIN_CTX } from './BasePlugin'
import { getBaseClass, getClassParam, getPluginInfo } from './PluginDecorator'
import {
	createErr,
	createOk,
	type PluginConstructor,
	type PluginIdentifier,
	type PluginInstance,
	type Result,
} from './types'

export type PluginDiContainer = DiodContainer<BasePlugin>

export class PluginContainer {
	/** Builder_Singleton 实例缓存（ExtendedContainerBuilder 共享） */
	public singletons = new Map<PluginIdentifier, PluginInstance>()
	private builder = new ExtendedContainerBuilder(this.singletons)

	public lastContainer!: PluginDiContainer

	private resetDraft() {
		this.builder.buildables.reset()
	}

	/**
	 * 注册插件：
	 * - Factory 仅构造与挂 ctx，不触发生命周期
	 * - 必选依赖进 withDependencies；可选依赖走 getMaybe
	 */
	public registerPlugin(Plugin: PluginConstructor): void {
		const info = getPluginInfo(Plugin)
		if (!info) throw new Error('缺少 @Plugin 装饰器元数据')

		const paramTypes = getClassParam(Plugin) as PluginIdentifier[]
		const n = paramTypes.length
		const baseOrSelf = info.base ?? Plugin

		// —— 局部掩码：只保留前 n 位，防止 n 之外的位干扰 —— //
		const maskN = n === 0 ? 0n : (1n << BigInt(n)) - 1n
		const maskedBits = info.optionals.bits & maskN
		const allRequired = maskedBits === 0n

		// —— 构建 mustDeps（两种快路径 + 精准容量，无 push）—— //
		let mustDeps: PluginIdentifier[]
		if (allRequired) {
			mustDeps = paramTypes
		} else {
			let requiredCount = 0
			for (let i = 0, m = 1n; i < n; i++, m <<= 1n) {
				if ((maskedBits & m) === 0n) requiredCount++
			}
			if (requiredCount === 0) {
				mustDeps = []
			} else {
				const arr = new Array<PluginIdentifier>(requiredCount)
				let k = 0
				for (let i = 0, m = 1n; i < n; i++, m <<= 1n) {
					if ((maskedBits & m) === 0n) arr[k++] = paramTypes[i]!
				}
				mustDeps = arr
			}
		}

		this.builder
			.register(baseOrSelf as any)
			.useFactory((c) => {
				const args = new Array(n)
				if (allRequired) {
					// —— 轻路径：全必需，无位运算 —— //
					for (let i = 0; i < n; i++) {
						const t = paramTypes[i]!
						args[i] = c.getResult(t).val as BasePlugin
					}
				} else {
					// —— 常规路径：按位选择 Maybe/Result —— //
					for (let i = 0, m = 1n; i < n; i++, m <<= 1n) {
						const t = paramTypes[i]!
						args[i] = (maskedBits & m) !== 0n ? c.getMaybe(t) : (c.getResult(t).val as BasePlugin)
					}
				}
				return new (Plugin as any)(...args)
			})
			.withDependencies(mustDeps)
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
