// services/LoaderService.ts
import {
	type Context,
	Injectable,
	type PluginConstructor,
	getClassParam,
	getOptionalPredicate,
	getPluginInfo,
} from '@pluxel/core'
import { PluginScanner } from './PluginScanner'
import { PluginRegistry } from './PluginRegistry'

declare module '@pluxel/core' {
	interface Context {
		loader: LoaderService
	}
}

@Injectable
export class LoaderService {
	static key = 'loader'
	private scanner = new PluginScanner()
	public registry: PluginRegistry

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
		this.registry = new PluginRegistry(this.ctx)
	}

	/**
	 * Load a module file, register its plugins, and set up HMR hooks.
	 */
	loadFileModule(id: string, mod: any) {
		this.registry.unregister(id)
		for (const exp of Object.values(mod)) {
			if (typeof exp !== 'function') continue
			const info = getPluginInfo(exp)
			if (!info) continue
			this.registry.register(id, exp as any)
		}

		if (import.meta.hot) {
			import.meta.hot.accept((newMod) => this.loadFileModule(id, newMod))
			import.meta.hot.dispose(() => this.registry.unregister(id))
		}
	}

	/**
	 * Scan directories for plugin entry paths.
	 */
	async scanPossiblePaths(dirs: string[]): Promise<string[]> {
		return this.scanner.findEntries(dirs)
	}

	/**
	 * Get names of currently loaded plugins.
	 */
	getLoadedPluginsName(): string[] {
		return this.registry.getLoadedNames()
	}

	getFullPluginStatus() {
		const loaded = this.registry.nameMap
		const container = this.ctx.registry.pluginRegistry.lastContainer
		const data: { id: string; isRunning: boolean }[] = []
		if (container === undefined) {
			const names = this.getLoadedPluginsName()
			return names.map((name) => ({ id: name, isRunning: false }))
		}
		for (const [name, ctor] of loaded.entries()) {
			const isRunning = container.services.get(ctor) !== undefined
			data.push({ id: name, isRunning })
		}
		return data
	}

	getPluginDependenciesInfo(ctor: PluginConstructor) {
		const predicate = getOptionalPredicate(ctor)
		const container = this.ctx.registry.pluginRegistry.lastContainer
		return getClassParam<PluginConstructor>(ctor).map((pluginClass, i) => {
			const info = getPluginInfo(pluginClass)
			if (info === undefined) return
			const isRunning = this.ctx.registry.isRunning(ctor)
			return {
				name: info.meta.name,
				optional: predicate.isOptional(i),
				isRunning,
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
