// PluginManager.ts
import {
	ExtendedContainerBuilder,
	type ExtendedDIContainer,
	type Identifier,
	type Newable,
} from '@/container'
import type { GlobalPluginContext } from './GlobalContext'
import type { BasePlugin } from './PluginBase'
import { createScopedContext, ScopedPluginContext } from './ScopedContext';
import {
	OPTIONAL_PARAMS_KEY,
	PARAM_TYPES,
	PLUGIN_META_KEY,
	type PluginMetadata,
} from './PluginDecorator'

export class PluginManager {
	private pluginClasses: Newable<BasePlugin>[] = []
	private containerBuilder: ExtendedContainerBuilder = new ExtendedContainerBuilder()
	private diContainer!: ExtendedDIContainer

	constructor(private globalCtx: GlobalPluginContext) {
		// 让容器内部能访问插件管理器单例
		this.containerBuilder.register(PluginManager).useInstance(this)
	}

	/**
	 * 注册插件时，通过 DI 容器 builder 注册插件类，
	 * 使用构造函数参数类型与 Optional 装饰器解析依赖。
	 */
	public registerPlugin(PluginClass: Newable<BasePlugin>): void {
		const meta = Reflect.getMetadata(
			PLUGIN_META_KEY,
			PluginClass,
		) as PluginMetadata
		if (!meta) {
			throw new Error(
				'Plugin metadata is missing. Ensure @Plugin decorator is applied.',
			)
		}
		this.globalCtx.logger.info(
			`Registering plugin: ${meta.name} [${meta.type}]`,
		)

		this.containerBuilder
			.register(PluginClass)
			.useFactory((c) => {
				const paramTypes: any[] =
					Reflect.getMetadata(PARAM_TYPES, PluginClass) || []
				this.globalCtx.logger.info(
					`Param types for ${PluginClass.name}: ${paramTypes
						.map((t) => t.name)
						.join(', ')}`,
				)
				const optionalParams: number[] =
					Reflect.getOwnMetadata(OPTIONAL_PARAMS_KEY, PluginClass) || []

				const dependencies = paramTypes.map((depType, index) => {
					if (optionalParams.includes(index)) {
						try {
							return c.get(depType)
						} catch (e) {
							return undefined
						}
					} else {
						return c.get(depType)
					}
				})
				return new PluginClass(...dependencies)
			})
			.asBuilderSingleton()

		this.pluginClasses.push(PluginClass)
	}

	public setContext() {}
	
	/**
	 * 构建 DI 容器，解析各插件实例，但不调用 init()。
	 * 返回构建结果，包括：
	 * - container：DI 容器
	 * - goodPlugins：能够实例化的插件标识列表
	 * - badPlugins：实例化失败的插件标识列表
	 */
	public commitWithStatus(): {
		container: ExtendedDIContainer;
		goodPlugins: Identifier<BasePlugin>[];
		badPlugins: { id: Identifier<BasePlugin>; error: PluginError }[];
	} {
		let container: ExtendedDIContainer;
		try {
			container = this.containerBuilder.build({});
		} catch (error) {
			this.globalCtx.logger.error('Container build failed:', error);
			throw error;
		}
		const plugins = container.getServices();
	
		const goodPlugins: Identifier<BasePlugin>[] = [];
		// 使用 Map 来存储坏插件，key 为插件标识符，value 为错误信息
		const badPlugins: Map<Identifier<BasePlugin>, PluginError> = new Map();
	
		// 使用 Map 的 has 方法快速检查是否已经记录该插件
		const markAsBad = (pluginId: Identifier<BasePlugin>, err: PluginError) => {
			if (badPlugins.has(pluginId)) return;
			badPlugins.set(pluginId, err);
			// 获取所有依赖该插件的插件，递归标记
			const dependents = this.containerBuilder.dependentsMap.get(pluginId) as Set<Identifier<BasePlugin>>;
			if (dependents) {
				dependents.forEach((dependentId) => {
					markAsBad(dependentId, {
						type: PluginErrorType.DEPENDENCY,
						message: `Dependency ${String(pluginId)} failed: ${err.message}`,
						cause: err,
					});
				});
			}
		};
	
		// 尝试构建各个插件实例
		for (const [identifier, _data] of plugins.entries()) {
			const pluginId = identifier as Identifier<BasePlugin>;
			try {
				// get 会触发 factory 函数。
				const plugin = container.get(pluginId);
				plugin.setContext(createScopedContext(this.globalCtx))

				goodPlugins.push(pluginId);
			} catch (error) {
				this.globalCtx.logger.error(
					`Error constructing plugin ${String(pluginId)}:`,
					error
				);
				const pluginErr: PluginError = {
					type: PluginErrorType.CONSTRUCTOR,
					message: error instanceof Error ? error.message : String(error),
					cause: error,
				};
				markAsBad(pluginId, pluginErr);
			}
		}
	
		// 如果存在错误插件，注销它们后重新构建容器
		if (badPlugins.size > 0) {
			this.containerBuilder.unregisterMultipleServices(Array.from(badPlugins.keys()));
			return this.commitWithStatus();
		}
		this.diContainer = container;
		// 将 Map 转换为数组形式返回
		return {
			container,
			goodPlugins,
			badPlugins: Array.from(badPlugins.entries()).map(([id, error]) => ({ id, error })),
		};
	}	
}

enum PluginErrorType {
	CONSTRUCTOR = 'CONSTRUCTOR_ERROR',
	DEPENDENCY = 'DEPENDENCY_ERROR'
}

interface PluginError {
	type: PluginErrorType;
	message: string;
	cause?: any;
}
