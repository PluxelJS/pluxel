import { parse } from 'valibot'
import {
	type Context,
	getPluginMeta,
	type ConfigSchemaMap,
	type PluginConstructor,
} from '../../context'

export class PluginRegistry {
	public moduleMap = new Map<string, PluginConstructor[]>()
	public nameMap = new Map<string, PluginConstructor>()
	public schemaCache = new WeakMap<PluginConstructor, ConfigSchemaMap>()

	constructor(private ctx: Context) {}

	/**
	 * Register a plugin class under a module ID, validate its config and enable it.
	 */
	register(moduleId: string, ctor: PluginConstructor) {
		const meta = getPluginMeta('META_KEY', ctor)!
		const pluginName = meta.name
		const list = this.moduleMap.get(moduleId) ?? []
		list.push(ctor)
		this.moduleMap.set(moduleId, list)
		this.nameMap.set(pluginName, ctor)
		if (this.ctx.configService.isEnable(pluginName)) {
			try {
				this.enablePlugin(pluginName, ctor)
			} catch (e) {
				this.disablePlugin(pluginName, ctor)
				this.ctx.logger.error(e, `插件 ${pluginName} 启用出错。`)
			}
		}
	}

	/**
	 * Unregister all plugin classes associated with a module ID.
	 */
	unregister(moduleId: string) {
		const ctors = this.moduleMap.get(moduleId) ?? []
		for (const ctor of ctors) {
			const meta = getPluginMeta('META_KEY', ctor)!
			// 注意这里取消注册不需要 disablePlugin 里在 configService 里 disable 的逻辑，单独写就好。
			this.ctx.registry.pluginRegistry.unregisterPlugin(ctor)
			this.nameMap.delete(meta.name)
		}
		this.moduleMap.delete(moduleId)
	}

	/**
	 * Validate plugin config and register it with the core registry.
	 */
	enablePlugin(name: string, ctor: PluginConstructor) {
		const schemaObjMap = this.getSchema(ctor)
		if (schemaObjMap) {
			const { configRecord } = this.ctx.configService.getConfig(name)
			for (const [configKey, schema] of Object.entries(schemaObjMap)) {
				const config = configRecord[configKey]
				if (config === undefined) throw new Error(`缺少配置 ${configKey}`)
				parse(schema, config)
			}
		}
		// 标记启用，并注册到核心 registry
		this.ctx.configService.enablePlugin(name)
		this.ctx.registry.pluginRegistry.registerPlugin(ctor)
	}

	disablePlugin(pluginName: string, ctor: PluginConstructor) {
		this.ctx.registry.pluginRegistry.unregisterPlugin(ctor)
		this.ctx.configService.disablePlugin(pluginName)
	}

	/**
	 * List names of currently loaded plugins.
	 */
	getLoadedNames(): string[] {
		return Array.from(this.nameMap.keys())
	}

	/**
	 * Get plugin constructor by its registered name.
	 */
	getPluginByName(name: string): PluginConstructor | undefined {
		return this.nameMap.get(name)
	}

	/**
	 * Lazy-load and cache the config schema for a plugin.
	 */
	public getSchema(ctor: PluginConstructor): ConfigSchemaMap | undefined {
		if (!this.schemaCache.has(ctor)) {
			const schemaObjMap = getPluginMeta('CONFIG_MAP', ctor) as
				| ConfigSchemaMap
				| undefined
			if (schemaObjMap) this.schemaCache.set(ctor, schemaObjMap)
		}
		return this.schemaCache.get(ctor)
	}
}
