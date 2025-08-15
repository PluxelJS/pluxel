// services/LoaderService.ts
import {
	type Context,
	Injectable,
	type PluginConstructor,
	getClassParam,
	getPluginMeta,
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
		this.ctx.on('beforeStart', (ctx: Context, plugin, instance) => {
			const schemaMap = this.registry.getSchema(plugin)
			if (!schemaMap) return
			const pluginName = ctx.pluginMeta.name
			const { configRecord: config } = ctx.configService.getConfig(pluginName)
			for (const [key] of Object.entries(schemaMap)) {
				if (!(key in config)) {
					throw new Error(`Missing config key "${key}" for plugin ${ctx.name}`)
				}
				instance[key] = config[key]
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
			const meta = getPluginMeta('META_KEY', exp)
			if (!meta) continue
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
		const optionalSet = new Set<number>(
			getPluginMeta('OPTIONAL_PARAMS_KEY', ctor),
		)
		const container = this.ctx.registry.pluginRegistry.lastContainer
		return getClassParam(ctor).map((pluginClass, i) => {
			const meta = getPluginMeta('META_KEY', pluginClass)
			if (meta === undefined) return
			const isRunning = container?.services.get(pluginClass) !== undefined
			return { name: meta.name, optional: optionalSet.has(i), isRunning }
		})
	}
	getPluginClassByName(name: string): PluginConstructor | undefined {
		return this.registry.getPluginByName(name)
	}

	getPluginSchema(ctor: PluginConstructor) {
		return this.registry.getSchema(ctor)
	}
}
