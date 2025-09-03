// PluginContainer.ts

import type { Context } from '@pluxel/context'
import type { Maybe } from 'option-t/maybe'
import { createErr, createOk, unwrapOk } from 'option-t/plain_result'
import { type DiodContainer, ExtendedContainerBuilder } from '../container'
import type { BasePlugin } from './BasePlugin'
import { PLUGIN_CTX } from './BasePlugin'
import { getClassParam, getPluginInfo } from './PluginDecorator'
import type { PluginConstructor, PluginIdentifier, PluginInstance } from './types'

export type PluginDiContainer = DiodContainer<BasePlugin>
export type createCTX = () => Context
export class PluginContainer {
	/** Builder_Singleton 实例缓存（ExtendedContainerBuilder 共享） */
	public singletons = new Map<PluginIdentifier, PluginInstance>()
	private builder = new ExtendedContainerBuilder(this.singletons)

	public lastContainer!: PluginDiContainer

	constructor(private createPluginContext: createCTX) {}

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

		// ---------- 预处理：BigInt 位掩码 -> 布尔表（热路径不再做 BigInt 运算） ----------
		const maskN = n === 0 ? 0n : (1n << BigInt(n)) - 1n
		const maskedBits = info.optionals.bits & maskN

		const isOptional: boolean[] = new Array(n)
		let allRequired = true
		for (let i = 0, m = 1n; i < n; i++, m <<= 1n) {
			const opt = (maskedBits & m) !== 0n
			isOptional[i] = opt
			if (opt) allRequired = false
		}

		// ---------- mustDeps：精准容量，无 push ----------
		let mustDeps: PluginIdentifier[]
		if (allRequired) {
			mustDeps = paramTypes
		} else {
			let requiredCount = 0
			for (let i = 0; i < n; i++) if (!isOptional[i]) requiredCount++
			if (requiredCount === 0) {
				mustDeps = []
			} else {
				const arr = new Array<PluginIdentifier>(requiredCount)
				for (let i = 0, k = 0; i < n; i++) if (!isOptional[i]) arr[k++] = paramTypes[i]!
				mustDeps = arr
			}
		}

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
				// —— 无参快路径 —— //
				if (n === 0) {
					const pluginCTX = this.createPluginContext()
					const instance = new (Plugin as any)()
					;(instance as any)[PLUGIN_CTX] = pluginCTX // 性能优先：直接赋值
					return instance
				}

				const pluginCTX = this.createPluginContext()

				// 避免稀疏数组（JIT 友好）
				const args: (BasePlugin | undefined)[] = new Array(n).fill(undefined)

				if (allRequired) {
					// —— 纯必需：无分支、无 Maybe —— //
					for (let i = 0; i < n; i++) {
						const t = paramTypes[i]!
						const parent = unwrapOk(c.getResult(t))
						args[i] = wrapWithCaller(parent, pluginCTX)
					}
				} else {
					// —— 可选 + 必需混合 —— //
					for (let i = 0; i < n; i++) {
						const t = paramTypes[i]!
						const parent = isOptional[i] ? c.getMaybe(t) : unwrapOk(c.getResult(t))
						if (parent) args[i] = wrapWithCaller(parent, pluginCTX)
						// 缺失可选依赖：保持 undefined；构造器自己处理
					}
				}

				// 注意：这里用可变参调用，若极端热可对 n∈{1,2,3} 做手写分支
				const instance = new (Plugin as any)(...args)
				;(instance as any)[PLUGIN_CTX] = pluginCTX // 性能优先：直接赋值
				return instance
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
