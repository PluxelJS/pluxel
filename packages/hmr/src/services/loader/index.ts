// services/LoaderService.ts
import {
	type Context,
	getClassParam,
	getOptionalPredicate,
	getPluginInfo,
	Injectable,
	type PluginConstructor,
} from '@pluxel/core'
import { PluginRegistry } from './PluginRegistry'

const serviceName = 'loader' as const
declare module '@pluxel/core' {
	interface Context {
		[serviceName]: LoaderService
	}
}
@Injectable({ key: serviceName })
export class LoaderService {
	public registry: PluginRegistry
	public pathAnchors: Set<string> = new Set()

	constructor(private ctx: Context) {
		this.ctx.on('beforeStart', (plugin) => {
			const ctor = plugin.constructor as PluginConstructor
			const schemaMap = this.registry.getSchema(ctor)
			if (!schemaMap) return
			const ctx = plugin.ctx
			const pluginName = ctx.pluginInfo.meta.name
			const { configRecord: config } = ctx.configService.getConfig(pluginName)
			for (const [key] of Object.entries(schemaMap)) {
				if (!(key in config)) {
					throw new Error(`Missing config key "${key}" for plugin ${ctx.name}`)
				}
				plugin[key] = config[key]
			}
		})
		this.ctx.on('commitFailed', (failed) => {
			for (const pCtor of failed) {
				const pluginName = getPluginInfo(pCtor)?.meta.name!
				this.registry.disablePlugin(pluginName, pCtor as PluginConstructor)
			}
		})
		this.registry = new PluginRegistry(this.ctx)
	}

	/**
	 * Load a module file, register its plugins, and set up HMR hooks.
	 */
	loadFileModule(id: string, mod: any): boolean {
		this.registry.unregister(id)
		let isPlugin = false
		for (const exp of Object.values(mod)) {
			if (typeof exp !== 'function') continue
			const info = getPluginInfo(exp)
			if (!info) continue
			this.registry.register(id, exp as any)
			isPlugin = true
		}

		if (isPlugin) {
			this.pathAnchors.add(id)
		} else {
			this.pathAnchors.delete(id)
		}

		if (import.meta.hot) {
			import.meta.hot.accept((newMod) => this.loadFileModule(id, newMod))
			import.meta.hot.dispose(() => this.registry.unregister(id))
		}

		return isPlugin
	}

	/**
	 * Get names of currently loaded plugins.
	 */
	getLoadedPluginsName(): string[] {
		return this.registry.getLoadedNames()
	}

	getFullPluginStatus() {
		const loaded = this.registry.nameMap // Map<string, Constructor>
		const byId: Record<string, { id: string; isRunning: boolean }> = Object.create(null)

		let runningCount = 0
		let stoppedCount = 0
		// 单次遍历，边统计边填充
		for (const [name, ctor] of loaded.entries()) {
			const isRunning = this.ctx.registry.isRunning(ctor)
			byId[name] = { id: name, isRunning }

			if (isRunning) {
				runningCount++
			} else {
				stoppedCount++
			}
		}

		return {
			statuses: byId,
			summary: {
				total: runningCount + stoppedCount,
				running: runningCount,
				stopped: stoppedCount,
			},
		}
	}

	getPluginDependenciesInfo(ctor: PluginConstructor) {
		const predicate = getOptionalPredicate(ctor)
		return getClassParam<PluginConstructor>(ctor).map((pluginClass, i) => {
			const info = getPluginInfo(pluginClass)
			if (info === undefined) return
			return {
				name: info.meta.name,
				optional: predicate.isOptional(i),
				isRunning: this.ctx.registry.isRunning(pluginClass),
			}
		})
	}
	getPluginClassByName(name: string): PluginConstructor | undefined {
		return this.registry.getPluginByName(name)
	}

	getPluginSchema(ctor: PluginConstructor) {
		return this.registry.getSchema(ctor)
	}
}
