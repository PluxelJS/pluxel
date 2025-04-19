import {
	ExtendedContainerBuilder,
	type ExtendedDIContainer,
	type Identifier,
	type Newable,
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
import { type PluginClass, type Result, createErr, createOk } from './types'

// 辅助函数：用于在 mutative 中正确克隆 ExtendedContainerBuilder 实例
const markBuilder = (target: unknown) =>
	target instanceof ExtendedContainerBuilder
		? () => {
				const clone = new ExtendedContainerBuilder()
				// 复制 buildables 和 builderSingletons 两个核心属性
				clone.buildables = target.buildables
				clone.builderSingletons = target.builderSingletons
				return clone
			}
		: undefined

export class PluginContainer {
	// 保存当前稳定的 builder 实例
	private currentBuilder = new ExtendedContainerBuilder()
	// 草稿 builder 与 finalize 方法
	private draftBuilder!: ExtendedContainerBuilder
	private finalize!: () => ExtendedContainerBuilder
	// 插件单例缓存，用于跨次调用保持实例不被重复创建
	private pluginSingletons: SingletonMap = new Map()
	// 上次成功构建的容器，用于无变更时快速返回
	private lastContainer: ExtendedDIContainer | null = null
	// 标记是否有未提交的变更
	private hasChanges = false

	/**
	 * 构造函数：初始化草稿状态
	 * @param globalCtx 全局插件上下文
	 */
	constructor(private globalCtx: GlobalContext) {
		this.resetDraft()
	}

	/**
	 * 重置草稿 builder：基于 currentBuilder 创建可变草稿
	 */
	private resetDraft() {
		;[this.draftBuilder, this.finalize] = create(this.currentBuilder, {
			mark: markBuilder,
		})
		this.hasChanges = false
	}

	/**
	 * 将插件实例的方法调用包装，以注入 callerContext
	 * @param instance 插件实例
	 * @param ctx 调用者上下文
	 * @returns 包装后的插件实例
	 */
	private injectCallerContext<T extends BasePlugin>(
		instance: T,
		ctx: PluginContext,
	): T {
		return new Proxy(instance, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver)
				if (typeof value !== 'function') return value
				return (...args: unknown[]) => {
					// 调用前注入 callerContext
					target[CALLER_CTX] = ctx
					try {
						// biome-ignore lint/complexity/noBannedTypes: <explanation>
						return (value as Function).apply(target, args)
					} finally {
						// 调用后清理 callerContext
						delete target[CALLER_CTX]
					}
				}
			},
		}) as T
	}

	/**
	 * 注册一个插件类到容器中
	 * @param Plugin 插件类
	 */
	public registerPlugin(Plugin: PluginClass): void {
		const meta = Reflect.getMetadata(PLUGIN_META_KEY, Plugin) as
			| PluginMetadata
			| undefined

		if (!meta) {
			throw new Error('缺少 @Plugin 装饰器元数据')
		}

		// 标记有变更
		this.hasChanges = true

		// 在草稿 builder 中注册插件
		this.draftBuilder
			.register(Plugin)
			.useFactory((container) => {
				// 获取构造函数依赖类型列表
				const types: unknown[] = Reflect.getMetadata(PARAM_TYPES, Plugin) || []
				// 获取可选参数索引列表
				const optional: number[] =
					Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, Plugin) || []

				// 创建插件专属上下文
				const ctx = createPluginContext(meta, this.globalCtx)
				// 解析并注入依赖
				const deps = types.map((depType, index) => {
					const isOptional = optional.includes(index)
					try {
						const depInstance = container.get(depType as Newable<BasePlugin>)
						return this.injectCallerContext(depInstance, ctx)
					} catch (e) {
						if (isOptional) {
							// 可选依赖失败时返回 undefined
							return undefined
						}
						throw e
					}
				})

				// 实例化插件并设置上下文
				const instance = new Plugin(...(deps as BasePlugin[]))
				instance.setContext(ctx)
				return instance
			})
			.asBuilderSingleton()
	}

	/**
	 * 注销一个插件类
	 * @param Plugin 插件类
	 */
	public unregisterPlugin(Plugin: PluginClass): void {
		this.hasChanges = true
		this.draftBuilder.unregister(Plugin)
	}

	/**
	 * 重新加载某个插件，同时清除其单例及其依赖的单例
	 * @param Plugin 插件类
	 * @returns 重新初始化的插件类列表
	 */
	public reloadPlugin(Plugin: PluginClass): PluginClass[] {
		// 移除自身单例缓存
		this.pluginSingletons.delete(Plugin)

		// 移除所有依赖自身的插件单例缓存
		const dependents = this.currentBuilder.dependents.get(Plugin) || []
		for (const dep of dependents) {
			this.pluginSingletons.delete(dep)
		}

		// 提交构建并返回需要重新初始化的列表
		const result = this.commit()
		if (!result.ok) {
			return []
		}
		// 构建成功，返回 dependents 作为需重建的插件列表
		return dependents as PluginClass[]
	}

	/**
	 * 提交所有变更，构建或返回缓存容器
	 */
	public commit(): Result<ExtendedDIContainer, VerificationError[]> {
		// 如果无变更且已有缓存，直接返回缓存
		if (!this.hasChanges && this.lastContainer) {
			return createOk(this.lastContainer)
		}

		try {
			// 使用草稿 builder 构建容器，复用外部单例
			const container = this.draftBuilder.build({
				outsideSingletons: this.pluginSingletons,
			})
			// 更新当前 builder 状态和缓存
			this.currentBuilder = this.finalize()
			this.lastContainer = container
			// 重置草稿状态
			this.resetDraft()

			return createOk(container)
		} catch (e) {
			// 捕获验证错误并返回
			if (e instanceof ServiceVerificationAggregateError) {
				return createErr(e.errors)
			}
			// 其他异常直接抛出
			throw e
		}
	}
}
