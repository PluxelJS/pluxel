import type { Context } from '@pluxel/core'
import type {
	BuiltinDocExtensionDef,
	BuiltinExtensionDef,
	CompiledExtensionModule,
	ExtensionManifest,
	ExtensionManifestEvent,
	ExtensionPoint,
	PluginExtensionConfig,
} from '../../web/plugin-ui/types'
import { HMR_INTERNAL_API_BASE, hmrExtensionModulePath } from '../../web/paths'

const MODULE_RETENTION_COUNT = 2

type ExtensionMode = 'compile' | 'registry-only' | 'disabled'

type StoredModule = {
	sourceHash: string
	code: string
	compiledAt: number
}

export interface ExtensionModuleStore {
	getCompiledModule(pluginName: string): CompiledExtensionModule | undefined
	commitCompiledModule(
		pluginName: string,
		sourceHash: string,
		code: string,
		compiledAt?: number,
	): Promise<void>
	removePlugin(pluginName: string): Promise<void>
}

export interface ExtensionServiceConfig {
	enabled?: boolean
	mode?: ExtensionMode
	/**
	 * Startup-only compiler injection (dev hosts).
	 *
	 * This is intentionally a plain reference on config: the decision is made at process startup
	 * and does not support runtime mode switching.
	 */
	compiler?: ExtensionCompilerApi | null
}

export type ExtensionCompilerApi = {
	attachStore?: (store: ExtensionModuleStore) => void
	bindModule: (ctx: Context, config: PluginExtensionConfig) => () => void
	requestCompile?: (pluginName: string) => Promise<void>
}

export class ExtensionService implements ExtensionModuleStore {
	private enabled = true
	private mode: ExtensionMode = 'compile'
	private compiler: ExtensionCompilerApi | null = null
	private warnedMissingCompiler = false
	private manifestVersion = 0
	private manifestModules: CompiledExtensionModule[] = []
	private readonly manifestListeners = new Set<(event: ExtensionManifestEvent) => void>()
	private readonly builtinsByPlugin = new Map<string, Map<string, BuiltinExtensionDef>>()
	private readonly modulesByPlugin = new Map<string, StoredModule[]>()

	constructor(
		public ctx: Context,
		config?: ExtensionServiceConfig,
	) {
		this.reconfigure(config)
	}

	reconfigure(config?: ExtensionServiceConfig): void {
		this.mode = config?.enabled === false ? 'disabled' : (config?.mode ?? 'compile')
		this.enabled = this.mode !== 'disabled'
		this.compiler = config?.compiler ?? null
		this.warnedMissingCompiler = false
		if (this.compiler && this.enabled && this.mode === 'compile') {
			this.compiler.attachStore?.(this)
		}
	}

	subscribeManifest(callback: (event: ExtensionManifestEvent) => void): () => void {
		this.manifestListeners.add(callback)
		return () => this.manifestListeners.delete(callback)
	}

	getManifest(): ExtensionManifest {
		if (!this.enabled) return { version: 0, modules: [], builtins: [] }
		return {
			version: this.manifestVersion,
			modules: this.manifestModules.slice(),
			builtins: this.getBuiltinsSnapshot(),
		}
	}

	getCompiledModule(pluginName: string): CompiledExtensionModule | undefined {
		return this.manifestModules.find((mod) => mod.pluginName === pluginName)
	}

	async getModuleSource(pluginName: string, sourceHash: string): Promise<string | null> {
		if (!this.enabled) return null
		const code = this.readStoredModule(pluginName, sourceHash)
		if (code) return code

		if (this.mode !== 'compile') return null
		const compiler = this.compiler
		if (compiler?.requestCompile) {
			await compiler.requestCompile(pluginName).catch((): undefined => undefined)
		}
		return null
	}

	async commitCompiledModule(
		pluginName: string,
		sourceHash: string,
		code: string,
		compiledAt = Date.now(),
	): Promise<void> {
		if (!this.enabled) return
		this.storeModule(pluginName, { sourceHash, code, compiledAt })
		this.setCompiledModuleRecord(pluginName, sourceHash, compiledAt)
	}

	async removePlugin(pluginName: string): Promise<void> {
		if (!this.enabled) return
		this.modulesByPlugin.delete(pluginName)
		this.removeManifestEntry(pluginName)
	}

	bindModule(config: PluginExtensionConfig): () => void {
		if (!this.enabled || this.mode !== 'compile') return () => undefined

		const compiler = this.compiler
		if (!compiler) {
			if (!this.warnedMissingCompiler) {
				this.warnedMissingCompiler = true
				this.ctx.logger.warn('Extension compiler not available; UI extension compilation disabled')
			}
			return () => undefined
		}

		return compiler.bindModule(this.ctx, config)
	}

	/**
	 * Register a host-rendered (JSON-serializable) UI extension, without shipping a plugin UI module.
	 *
	 * Designed for markdown docs with builtin blocks that should not require `await import()`.
	 */
	registerBuiltin(def: Omit<BuiltinExtensionDef, 'pluginName'>): () => void {
		if (!this.enabled) return () => undefined
		const pluginName = this.ctx.pluginInfo.id
		const id = String(def.id ?? '').trim()
		const point = String(def.point ?? '').trim()
		const kind = String(def.kind ?? '').trim()
		if (!id) throw new Error('[ExtensionService] registerBuiltin: id required')
		if (!point) throw new Error('[ExtensionService] registerBuiltin: point required')
		if (!kind) throw new Error('[ExtensionService] registerBuiltin: kind required')

		const normalized: BuiltinExtensionDef = {
			...def,
			id,
			point: point as ExtensionPoint,
			kind: kind as BuiltinExtensionDef['kind'],
			pluginName,
		}
		try {
			JSON.stringify(normalized)
		} catch (_err) {
			throw new Error(
				`[ExtensionService] registerBuiltin: def must be JSON-serializable (id=${id}, point=${point}, kind=${kind})`,
			)
		}

		this.addBuiltin(normalized)
		const guard = this.ctx.effects.defer(() => {
			this.removeBuiltin(normalized)
		})
		return () => guard.dispose()
	}

	doc<P extends ExtensionPoint = 'plugin:tabs'>(
		input: Omit<BuiltinDocExtensionDef<P>, 'kind' | 'pluginName' | 'point'> & { point?: P },
	): () => void {
		const { point, ...rest } = input
		const def: Omit<BuiltinExtensionDef, 'pluginName'> = {
			...(rest as unknown as Omit<BuiltinExtensionDef, 'pluginName'>),
			kind: 'doc',
			point: (point ?? ('plugin:tabs' as P)) as P,
		}
		return this.registerBuiltin(def)
	}

	private addBuiltin(def: BuiltinExtensionDef): void {
		if (!this.enabled) return
		const pluginName = def.pluginName
		const key = `${String(def.point)}:${String(def.id)}`
		let bucket = this.builtinsByPlugin.get(pluginName)
		if (!bucket) {
			bucket = new Map()
			this.builtinsByPlugin.set(pluginName, bucket)
		}
		bucket.set(key, def)
		this.bumpManifestSync()
	}

	private removeBuiltin(def: BuiltinExtensionDef): void {
		if (!this.enabled) return
		const bucket = this.builtinsByPlugin.get(def.pluginName)
		if (!bucket) return
		const key = `${String(def.point)}:${String(def.id)}`
		if (bucket.get(key) !== def) return
		bucket.delete(key)
		if (bucket.size === 0) this.builtinsByPlugin.delete(def.pluginName)
		this.bumpManifestSync()
	}

	private readStoredModule(pluginName: string, sourceHash: string): string | null {
		const list = this.modulesByPlugin.get(pluginName)
		if (!list?.length) {
			this.removeManifestEntry(pluginName)
			return null
		}

		const hit = list.find((module) => module.sourceHash === sourceHash)
		return hit?.code ?? null
	}

	private storeModule(pluginName: string, module: StoredModule): void {
		const current = this.modulesByPlugin.get(pluginName) ?? []
		const next = current.filter((entry) => entry.sourceHash !== module.sourceHash)
		next.push(module)
		next.sort((a, b) => b.compiledAt - a.compiledAt)
		this.modulesByPlugin.set(pluginName, next.slice(0, Math.max(1, MODULE_RETENTION_COUNT)))
	}

	private setCompiledModuleRecord(
		pluginName: string,
		sourceHash: string,
		compiledAt: number,
	): void {
		const moduleUrl = this.getModuleUrl(pluginName, sourceHash)
		const previous = this.getCompiledModule(pluginName)
		if (
			previous &&
			previous.sourceHash === sourceHash &&
			previous.moduleUrl === moduleUrl &&
			previous.compiledAt === compiledAt
		) {
			return
		}

		const nextModules = this.manifestModules.filter((mod) => mod.pluginName !== pluginName)
		nextModules.push({
			pluginName,
			moduleUrl,
			sourceHash,
			compiledAt,
		})
		nextModules.sort((a, b) => a.pluginName.localeCompare(b.pluginName))

		this.manifestVersion += 1
		this.manifestModules = nextModules
		this.notifyManifest({
			type: 'update',
			version: this.manifestVersion,
			pluginName,
			sourceHash,
			moduleUrl,
			compiledAt,
		})
	}

	private removeManifestEntry(pluginName: string): void {
		const nextModules = this.manifestModules.filter((mod) => mod.pluginName !== pluginName)
		if (nextModules.length === this.manifestModules.length) return
		this.manifestVersion += 1
		this.manifestModules = nextModules
		this.notifyManifest({
			type: 'remove',
			version: this.manifestVersion,
			pluginName,
		})
	}

	private getBuiltinsSnapshot(): BuiltinExtensionDef[] {
		const builtins: BuiltinExtensionDef[] = []
		for (const bucket of this.builtinsByPlugin.values()) {
			for (const def of bucket.values()) builtins.push(def)
		}
		builtins.sort((a, b) => {
			const pluginDiff = a.pluginName.localeCompare(b.pluginName)
			if (pluginDiff !== 0) return pluginDiff
			const pointDiff = String(a.point).localeCompare(String(b.point))
			if (pointDiff !== 0) return pointDiff
			return String(a.id).localeCompare(String(b.id))
		})
		return builtins
	}

	private bumpManifestSync(): void {
		this.manifestVersion += 1
		this.notifyManifest({
			type: 'sync',
			version: this.manifestVersion,
		})
	}

	private notifyManifest(event: ExtensionManifestEvent): void {
		for (const listener of this.manifestListeners) {
			try {
				listener(event)
			} catch (error) {
				if (this.ctx.logger) this.ctx.logger.error('manifest listener failed', { error })
				else console.error('manifest listener failed', { error })
			}
		}
	}

	private getModuleUrl(pluginName: string, sourceHash: string): string {
		return `${HMR_INTERNAL_API_BASE}${hmrExtensionModulePath(
			pluginName,
			`${sourceHash}.mjs`,
		)}`
	}
}
