import {
	type Container,
	ExtendedContainerBuilder,
	type ExtendedDIContainer,
	ServiceVerificationAggregateError,
	type SingletonMap,
} from '@/container'
import { create } from 'mutative'
import type { VerificationError } from '../../../diod/src/verifier'
import type { BasePlugin } from './BasePlugin'
import type { GlobalContext } from './GlobalContext'
import {
	CALLER_CTX,
	type PluginContext,
	createPluginContext,
} from './PluginContext'
import {
	OPTIONAL_PARAMS_KEY,
	PARAM_TYPES,
	PLUGIN_META_KEY,
	type PluginMetadata,
} from './PluginDecorator'
import { PluginSingletonRegistry } from './PluginSingletonRegistry'
import {
	type PluginClass,
	type PluginIdentifier,
	type Result,
	createErr,
	createOk,
} from './types'

export class PluginContainer {
	private currentBuilder = new ExtendedContainerBuilder()
	private draftBuilder!: ExtendedContainerBuilder
	private finalize!: () => ExtendedContainerBuilder

	// 用 Registry 管理单例
	public singletons = new PluginSingletonRegistry<
		PluginIdentifier,
		BasePlugin
	>()
	private lastContainer!: ExtendedDIContainer
	private hasChanges = false

	constructor(private globalCtx: GlobalContext) {
		this.resetDraft()
	}

	private resetDraft() {
		;[this.draftBuilder, this.finalize] = create(this.currentBuilder, {
			mark: (target) =>
				target instanceof ExtendedContainerBuilder
					? () => {
							const clone = new ExtendedContainerBuilder()
							clone.buildables = new Map(target.buildables)
							clone.builderSingletons = new Map(target.builderSingletons)
							return clone
						}
					: undefined,
		})
		this.hasChanges = false
	}

	private injectCallerContext<T extends BasePlugin>(
		instance: T,
		ctx: PluginContext,
	): T {
		const clone = Object.assign(
			Object.create(Object.getPrototypeOf(instance)),
			instance,
		)
		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		;(clone as any)[CALLER_CTX] = ctx
		return clone
	}

	public registerPlugin(Plugin: PluginClass): void {
		const meta = Reflect.getMetadata(PLUGIN_META_KEY, Plugin) as
			| PluginMetadata
			| undefined
		if (!meta) throw new Error('缺少 @Plugin 装饰器元数据')
		this.hasChanges = true

		const types: PluginIdentifier[] =
			Reflect.getMetadata(PARAM_TYPES, Plugin) || []
		const optionalSet = new Set<number>(
			Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, Plugin) || [],
		)
		const ctx = createPluginContext(meta, this.globalCtx)

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
				return this.injectCallerContext(inst, ctx)
			})
		}

		this.draftBuilder
			.register(Plugin)
			.useFactory((container) => {
				const deps = resolvers.map((fn) => fn(container))
				const instance = new Plugin(...deps)
				instance.setContext(ctx)
				// get 的时候会自己放到 registry，build 那传入了
				// this.registry.set(Plugin, instance)
				return instance
			})
			.withDependencies(mustDeps)
			.asBuilderSingleton()
	}

	public unregisterPlugin(Plugin: PluginClass): void {
		this.hasChanges = true
		const dependents = this.lastContainer.dependents.get(Plugin) || []
		for (const dep of dependents) {
			this.singletons.delete(dep)
		}
		this.draftBuilder.unregister(Plugin)
	}

	public reloadPlugin(Plugin: PluginClass): PluginClass[] {
		this.singletons.delete(Plugin)
		const dependents = this.lastContainer.dependents.get(Plugin) || []
		for (const dep of dependents) {
			this.singletons.delete(dep)
		}
		const result = this.commit()
		if (!result.ok) return []
		return dependents as PluginClass[]
	}

	public commit(): Result<ExtendedDIContainer, VerificationError[]> {
		if (!this.hasChanges && this.lastContainer) {
			return createOk(this.lastContainer)
		}
		try {
			const container = this.draftBuilder.build({
				outsideSingletons: this.singletons.getMap(),
			})
			this.currentBuilder = this.finalize()
			this.lastContainer = container
			// 合并 registry 并获取本次改动
			const changes = this.singletons.commit()
			console.log('Registry changes:', changes)
			this.resetDraft()
			return createOk(container)
		} catch (e) {
			if (e instanceof ServiceVerificationAggregateError) {
				return createErr(e.errors)
			}
			throw e
		}
	}
}
