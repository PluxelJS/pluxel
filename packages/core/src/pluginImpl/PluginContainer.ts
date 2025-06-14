import {
	type Container,
	ExtendedContainerBuilder,
	type ExtendedDIContainer,
	ServiceVerificationAggregateError,
} from '@/container'
import { type Context, EffectScopeService } from '@/index'
import { type BasePlugin, PLUGIN_CTX } from './BasePlugin'
import {
	OPTIONAL_PARAMS_KEY,
	PARAM_TYPES,
	PLUGIN_META_KEY,
	type PluginMetadata,
} from './PluginDecorator'
import {
	type PluginClass,
	type PluginIdentifier,
	type PluginInstance,
	type Result,
	createErr,
	createOk,
} from './types'

export class PluginContainer {
	private builder = new ExtendedContainerBuilder()

	// 用 Registry 管理单例
	public singletons = new Map<PluginClass, PluginInstance>()
	public lastContainer!: ExtendedDIContainer

	constructor(private ctx: Context) {}

	private resetDraft() {
		this.builder.buildables.reset()
	}

	public registerPlugin(Plugin: PluginClass): void {
		const meta = Reflect.getMetadata(PLUGIN_META_KEY, Plugin) as
			| PluginMetadata
			| undefined
		if (!meta) throw new Error('缺少 @Plugin 装饰器元数据')

		const types: PluginIdentifier[] =
			Reflect.getMetadata(PARAM_TYPES, Plugin) || []
		const optionalSet = new Set<number>(
			Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, Plugin) || [],
		)

		const pluginCtx = this.ctx.isolate([EffectScopeService])

		const mustDeps: PluginIdentifier[] = []
		const resolvers: ((c: Container) => BasePlugin | undefined)[] = []

		for (let i = 0; i < types.length; i++) {
			const type = types[i]
			const isOpt = optionalSet.has(i)
			if (!isOpt) mustDeps.push(type)

			resolvers.push((container) => {
				if (isOpt) {
					try {
						return container.get(type)
					} catch {
						return undefined
					}
				}
				const inst = container.get(type)
				inst.ctx.caller = pluginCtx
				pluginCtx.parent = inst.ctx
				return inst
			})
		}
		this.builder
			.register(Plugin)
			.useFactory((container) => {
				const deps = resolvers.map((fn) => fn(container))
				const instance = new Plugin(...deps)
				instance[PLUGIN_CTX] = pluginCtx
				// dispose 时删除插件实例化本身
				pluginCtx.collect(() => {
					console.log(this.singletons.keys())
					this.singletons.delete(Plugin)
					console.log(this.singletons.keys())
				})
				return instance
			})
			.withDependencies(mustDeps)
			.asBuilderSingleton()
	}

	public unregisterPlugin(Plugin: PluginIdentifier): void {
		// Process all dependents recursively
		const processDependents = (plugin: PluginIdentifier) => {
			const dependents = this.lastContainer?.dependents.get(plugin) || []

			for (const dep of dependents) {
				// Only unregister if the dependent has no other dependents
				if (!this.lastContainer?.dependents.get(dep)?.size) {
					processDependents(dep)
					this.builder.unregister(dep)
				}
			}
		}

		processDependents(Plugin)

		this.builder.unregister(Plugin)
	}

	public reloadPlugin(Plugin: PluginClass) {
		const buildables = this.builder.buildables
		if (buildables.has(Plugin) === false) {
			throw new Error('You can not reload an unloaded Plugin.')
		}
		// Process all dependents recursively
		const processDependents = (plugin: PluginIdentifier) => {
			const dependents = this.lastContainer?.dependents.get(plugin) || []

			for (const dep of dependents) {
				// Only unregister if the dependent has no other dependents
				if (!this.lastContainer?.dependents.get(dep)?.size) {
					processDependents(dep)
					buildables.set(dep, buildables.get(dep)!)
				}
			}
		}

		processDependents(Plugin)
		this.registerPlugin(Plugin)
	}

	public build() {
		const builder = this.builder

		const ret: {
			container: ExtendedDIContainer
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

		try {
			ret.changes = builder.buildables.commit()
			ret.container = builder.build({
				outsideSingletons: this.singletons,
			})
		} catch (e) {
			if (e instanceof ServiceVerificationAggregateError) {
				return createErr({ err: e.errors, ret })
			}
			throw e
		}
		ret.confirm = () => {
			this.lastContainer = ret.container
		}
		return createOk(ret)
	}
}
