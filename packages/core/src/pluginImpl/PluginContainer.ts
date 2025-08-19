// PluginContainer.ts
import type { Context } from '..'
import {
	ExtendedContainerBuilder,
	type DiodContainer,
	type FactoryContext,
	// 下面两个类型用于重建别名索引
	type Identifier,
	type AliasKey,
} from '../container'
import { type BasePlugin, PLUGIN_CTX } from './BasePlugin'
import { getBaseClass, getClassParam, getPluginMeta } from './PluginDecorator'
import {
	type PluginConstructor,
	type PluginIdentifier,
	type PluginInstance,
	type Result,
	createErr,
	createOk,
} from './types'

export type PluginDiContainer = DiodContainer<BasePlugin>

export class PluginContainer {
	/** Builder_Singleton 实例缓存（ExtendedContainerBuilder 共享） */
	public singletons = new Map<PluginIdentifier, PluginInstance>()
	private builder = new ExtendedContainerBuilder(this.singletons)

	public lastContainer!: PluginDiContainer

	constructor(private createPluginCTX: () => Context) {}

	private resetDraft() {
		this.builder.buildables.reset()
	}

	/**
	 * 注册插件：
	 * - Factory 仅构造与挂 ctx，不触发生命周期
	 * - 必选依赖进 withDependencies；可选依赖走 getMaybe
	 */
	public registerPlugin(Plugin: PluginConstructor): void {
		const meta = getPluginMeta('META_KEY', Plugin)
		if (!meta) throw new Error('缺少 @Plugin 装饰器元数据')

		const paramTypes = getClassParam(Plugin) as PluginIdentifier[]
		const optionalSet = new Set<number>(
			getPluginMeta('OPTIONAL_PARAMS_KEY', Plugin),
		)

		const pluginCtx = this.createPluginCTX()
		pluginCtx.pluginMeta = meta

		const mustDeps: PluginIdentifier[] = []
		const resolvers: ((c: FactoryContext) => BasePlugin | undefined | null)[] =
			[]

		for (let i = 0; i < paramTypes.length; i++) {
			const t = paramTypes[i]!
			const isOpt = optionalSet.has(i)
			if (!isOpt) mustDeps.push(t)
			resolvers.push((c) =>
				isOpt ? c.getMaybe(t) : (c.getResult(t).val as BasePlugin),
			)
		}

		const baseAbstractClass = getBaseClass(Plugin)

		this.builder
			.register(baseAbstractClass ?? Plugin)
			.useFactory((container) => {
				const args = resolvers.map((fn) => fn(container))
				return new (Plugin as any)(...args)
			})
			.withDependencies(mustDeps)
			.asBuilderSingleton()
	}

	/**
	 * 卸载：深度优先仅修改草稿；实际停机在 PluginService.commit() 中统一执行
	 */
	public unregisterPlugin(plugin: PluginIdentifier): void {
		const children =
			this.lastContainer?.dependents.get(plugin) ?? new Set<PluginIdentifier>()
		for (const dep of children) this.unregisterPlugin(dep)
		this.builder.tryUnregister(plugin)
	}

	/**
	 * 热重载：清理受影响 id 的 Builder_Singleton 缓存；root 可替换新类
	 * 实际启停仍在 PluginService.commit()
	 */
	public reloadPlugin(
		root: PluginIdentifier,
		newClass?: PluginConstructor,
	): void {
		if (!this.builder.buildables.has(root)) {
			throw new Error('You can not reload an unloaded Plugin.')
		}

		const depsMap = new Map<PluginIdentifier, Set<PluginIdentifier>>(
			this.lastContainer?.dependents,
		)

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

	/**
	 * 使用“排除集”裁剪一个新的容器：
	 * - 从 base.services/dependents 里删除 exclude 的条目
	 * - 重建 aliasIndex（firstWins，删除不会引入冲突）
	 * - 复用 builder_singletons（本类持有的 this.singletons）
	 */
	public finalizeWithFilter(
		base: PluginDiContainer,
		exclude: Set<PluginIdentifier>,
	): PluginDiContainer {
		// 1) 过滤 services
		const services = new Map<Identifier<BasePlugin>, any>()
		for (const [id, meta] of base.services as ReadonlyMap<
			Identifier<BasePlugin>,
			any
		>) {
			if (!exclude.has(id as PluginIdentifier)) services.set(id, meta)
		}

		// 2) 过滤 dependents，仅保留仍存在于 services 的 id
		const dependents = new Map<
			Identifier<BasePlugin>,
			Set<Identifier<BasePlugin>>
		>()
		for (const [id, set] of base.dependents as ReadonlyMap<
			Identifier<BasePlugin>,
			Set<Identifier<BasePlugin>>
		>) {
			if (exclude.has(id as PluginIdentifier)) continue
			if (!services.has(id)) continue
			const kept = new Set<Identifier<BasePlugin>>()
			for (const d of set) {
				if (!exclude.has(d as PluginIdentifier) && services.has(d)) {
					kept.add(d)
				}
			}
			dependents.set(id, kept)
		}

		// 3) 重建 aliasIndex（firstWins）
		const aliasIndex = new Map<AliasKey, Identifier<BasePlugin>>()
		for (const [id, meta] of services) {
			const aliases = meta.aliases as readonly AliasKey[] | undefined
			if (!aliases) continue
			for (let i = 0; i < aliases.length; i++) {
				const a = aliases[i]!
				if (!aliasIndex.has(a)) aliasIndex.set(a, id)
			}
		}

		// 4) 构造新的 DiodContainer（会重建 tagIndex）
		//    复用 this.singletons（Builder_Singleton 实例缓存）
		// biome-ignore lint/suspicious/noExplicitAny:
		return new (base.constructor as any)(
			services,
			dependents,
			this.builder.builderSingletons as any,
			aliasIndex as any,
		) as PluginDiContainer
	}
}
