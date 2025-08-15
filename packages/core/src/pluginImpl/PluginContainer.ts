import type { Context } from '..'
import {
	ExtendedContainerBuilder,
	type DiodContainer,
	type FactoryContext,
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
	// 用 Registry 管理单例
	public singletons = new Map<PluginConstructor, PluginInstance>()
	private builder = new ExtendedContainerBuilder(this.singletons)

	public lastContainer!: PluginDiContainer

	constructor(private createPluginCTX: () => Context) {}

	private resetDraft() {
		this.builder.buildables.reset()
	}

	public registerPlugin(Plugin: PluginConstructor): void {
		const meta = getPluginMeta('META_KEY', Plugin)
		if (!meta) throw new Error('缺少 @Plugin 装饰器元数据')
		const types = getClassParam(Plugin) as PluginIdentifier[]
		const optionalSet = new Set<number>(
			getPluginMeta('OPTIONAL_PARAMS_KEY', Plugin),
		)
		const pluginCtx = this.createPluginCTX()
		pluginCtx.pluginMeta = meta

		const mustDeps: PluginIdentifier[] = []
		const resolvers: ((c: FactoryContext) => BasePlugin | undefined | null)[] =
			[]

		for (let i = 0; i < types.length; i++) {
			const type = types[i]
			const isOpt = optionalSet.has(i)
			if (!isOpt) mustDeps.push(type)

			resolvers.push((container) => {
				if (isOpt) {
					return container.getMaybe(type)
				}
				const res = container.getResult(type)
				if (res.err) {
					throw new Error('不应该在运行时才发现缺依赖')
				}
				const inst = res.val
				inst.ctx.caller = pluginCtx
				return inst
			})
		}

		const baseAbstractClass = getBaseClass(Plugin)
		this.builder
			.register(baseAbstractClass ?? Plugin)
			.useFactory((container) => {
				const deps = resolvers.map((fn) => fn(container))
				const instance = new Plugin(...deps)
				instance[PLUGIN_CTX] = pluginCtx
				// dispose 时删除插件实例化本身
				pluginCtx.collect(() => {
					this.singletons.delete(Plugin)
				})
				pluginCtx.emitWithContext(
					instance,
					'beforeStart',
					pluginCtx,
					Plugin,
					instance,
				)
				return instance
			})
			.withDependencies(mustDeps)
			.asBuilderSingleton()
	}

	public unregisterPlugin(plugin: PluginIdentifier): void {
		// 深度优先：先卸载所有依赖于它的插件
		const children =
			this.lastContainer?.dependents.get(plugin) ?? new Set<PluginIdentifier>()
		for (const dep of children) {
			this.unregisterPlugin(dep)
		}
		// 最后才卸载自身
		this.builder.tryUnregister(plugin)
	}

	public reloadPlugin(
		root: PluginIdentifier,
		newClass?: PluginConstructor,
	): void {
		// 1. 校验：必须已加载
		if (!this.builder.buildables.has(root)) {
			throw new Error('You can not reload an unloaded Plugin.')
		}

		// 2. 快照 dependents 关系
		const depsMap = new Map<PluginIdentifier, Set<PluginIdentifier>>(
			this.lastContainer?.dependents,
		)

		// 3. 收集 root 及所有子孙 dependents
		const affected = new Set<PluginIdentifier>()
		const collect = (id: PluginIdentifier) => {
			if (affected.has(id)) return
			affected.add(id)
			for (const child of depsMap.get(id) ?? []) {
				collect(child)
			}
		}
		collect(root)

		// 5. 拓扑排序：父先子后
		const order: PluginIdentifier[] = []
		const dfs = (id: PluginIdentifier) => {
			if (!affected.has(id)) return
			order.push(id)
			for (const child of depsMap.get(id) ?? []) {
				dfs(child)
			}
		}
		dfs(root)

		// 6. 一次性刷写 buildables，触发 Builder 的内部 reload
		for (const id of order) {
			if (id === root) {
				if (newClass) {
					// 会覆盖原来的触发重载而不触发卸载下边的依赖项
					this.registerPlugin(newClass)
					continue
				}
				this.builder.dispatchReload(root)
			}
			this.builder.dispatchReload(id)
		}
	}

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

		if (result.err) {
			return createErr({ err: result.err, ret })
		}

		ret.container = result.val as DiodContainer<BasePlugin>
		ret.confirm = () => {
			this.lastContainer = result.val as DiodContainer<BasePlugin>
		}

		return createOk(ret)
	}
}
