import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@pluxel/core'
import { dirname, isAbsolute, resolve } from 'pathe'
import { resolveModuleIdBaseDir } from '../../runtime/module-id'
import { findNearestPackageRoot } from '../../shared'
import type {
	BuiltinDocExtensionDef,
	BuiltinExtensionDef,
	CompiledExtensionModule,
	ExtensionManifest,
	ExtensionManifestEvent,
	ExtensionModuleState,
} from '../../web/extensions'
import type { ExtensionPoint } from '../../web/ui'
import {
	EXTENSION_FEDERATION_EXPOSE,
	EXTENSION_FEDERATION_MANIFEST_FILE,
	extensionFederationBuildManifestPath,
	extensionFederationManifestPath,
	extensionFederationRemoteName,
} from '../../web/federation'
import { HMR_INTERNAL_API_BASE, hmrExtensionArtifactPath } from '../../web/paths'

export interface ExtensionModuleStore {
	getCompiledModule(pluginName: string): CompiledExtensionModule | undefined
	commitCompiledModule(
		module: CompiledExtensionModule,
		options?: { artifactRoot?: string | null },
	): Promise<void>
	markCompiling?(
		pluginName: string,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void>
	markCompileError?(
		pluginName: string,
		error: unknown,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void>
	removePlugin(pluginName: string): Promise<void>
}

export interface ExtensionServiceConfig {
	enabled?: boolean
}

export class ExtensionService implements ExtensionModuleStore {
	private enabled = true
	private manifestVersion = 0
	private manifestModules: CompiledExtensionModule[] = []
	private readonly moduleStatesByPlugin = new Map<string, ExtensionModuleState>()
	private readonly artifactRootsByPlugin = new Map<string, { sourceHash: string; dir: string }>()
	private readonly manifestListeners = new Set<(event: ExtensionManifestEvent) => void>()
	private readonly builtinsByPlugin = new Map<string, Map<string, BuiltinExtensionDef>>()

	constructor(
		public ctx: Context,
		config?: ExtensionServiceConfig,
	) {
		this.reconfigure(config)
	}

	reconfigure(config?: ExtensionServiceConfig): void {
		this.enabled = config?.enabled !== false
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
			states: this.getModuleStatesSnapshot(),
		}
	}

	getCompiledModule(pluginName: string): CompiledExtensionModule | undefined {
		return this.manifestModules.find((mod) => mod.pluginName === pluginName)
	}

	async commitCompiledModule(
		module: CompiledExtensionModule,
		options?: { artifactRoot?: string | null },
	): Promise<void> {
		if (!this.enabled) return
		if (options?.artifactRoot) {
			this.artifactRootsByPlugin.set(module.pluginName, {
				sourceHash: module.sourceHash,
				dir: options.artifactRoot,
			})
		}
		this.setCompiledModuleRecord(module)
	}

	async markCompiling(
		pluginName: string,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void> {
		if (!this.enabled) return
		const current = this.getCompiledModule(pluginName)
		const next: ExtensionModuleState = {
			pluginName,
			state: 'building',
			updatedAt: options?.updatedAt ?? Date.now(),
			sourceHash: options?.sourceHash ?? current?.sourceHash,
			compiledAt: options?.compiledAt ?? current?.compiledAt,
		}
		this.setModuleStateRecord(next)
	}

	async markCompileError(
		pluginName: string,
		error: unknown,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void> {
		if (!this.enabled) return
		const current = this.getCompiledModule(pluginName)
		const next: ExtensionModuleState = {
			pluginName,
			state: 'error',
			updatedAt: options?.updatedAt ?? Date.now(),
			sourceHash: options?.sourceHash ?? current?.sourceHash,
			compiledAt: options?.compiledAt ?? current?.compiledAt,
			message: errorMessage(error),
		}
		this.setModuleStateRecord(next)
	}

	async removePlugin(pluginName: string): Promise<void> {
		if (!this.enabled) return
		this.artifactRootsByPlugin.delete(pluginName)
		this.moduleStatesByPlugin.delete(pluginName)
		this.removeManifestEntry(pluginName)
	}

	packaged(input?: { manifestPath?: string | null }): () => void {
		if (!this.enabled) return () => undefined
		const pluginName = this.ctx.pluginInfo.id
		let disposed = false

		void this.registerPackagedModule(pluginName, input?.manifestPath).catch((error) => {
			if (disposed) return
			this.ctx.logger.error('failed to register packaged extension module', {
				pluginName,
				error,
			})
		})

		const guard = this.ctx.effects.defer(() => {
			disposed = true
			void this.removePlugin(pluginName)
		})
		return () => guard.dispose()
	}

	resolveArtifactFile(pluginName: string, sourceHash: string, file: string): string | null {
		const normalizedFile = normalizeArtifactFile(file)
		if (!normalizedFile) return null

		const stored = this.artifactRootsByPlugin.get(pluginName)
		const baseDir = stored && stored.sourceHash === sourceHash ? stored.dir : null
		if (!baseDir) return null
		const fullPath = resolve(baseDir, normalizedFile)
		if (fullPath !== baseDir && !fullPath.startsWith(`${baseDir}/`)) return null
		return fullPath
	}

	/**
	 * Register a host-rendered (JSON-serializable) UI extension, without shipping a plugin UI module.
	 *
	 * Designed for markdown docs with builtin blocks that should not require `await import()`.
	 */
	private registerBuiltin(def: Omit<BuiltinExtensionDef, 'pluginName'>): () => void {
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

	private setCompiledModuleRecord(module: CompiledExtensionModule): void {
		const previous = this.getCompiledModule(module.pluginName)
		const currentState = this.moduleStatesByPlugin.get(module.pluginName)
		if (
			previous &&
			previous.sourceHash === module.sourceHash &&
			previous.remoteName === module.remoteName &&
			previous.manifestUrl === module.manifestUrl &&
			previous.exposedModule === module.exposedModule &&
			previous.compiledAt === module.compiledAt &&
			currentState?.state === 'ready' &&
			currentState.sourceHash === module.sourceHash &&
			currentState.compiledAt === module.compiledAt
		) {
			return
		}

		const nextModules = this.manifestModules.filter((mod) => mod.pluginName !== module.pluginName)
		nextModules.push(module)
		nextModules.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
		this.moduleStatesByPlugin.set(module.pluginName, {
			pluginName: module.pluginName,
			state: 'ready',
			updatedAt: module.compiledAt,
			sourceHash: module.sourceHash,
			compiledAt: module.compiledAt,
		})

		this.manifestVersion += 1
		this.manifestModules = nextModules
		this.notifyManifest({
			type: 'update',
			version: this.manifestVersion,
			pluginName: module.pluginName,
			remoteName: module.remoteName,
			manifestUrl: module.manifestUrl,
			exposedModule: module.exposedModule,
			sourceHash: module.sourceHash,
			compiledAt: module.compiledAt,
		})
	}

	private removeManifestEntry(pluginName: string): void {
		const nextModules = this.manifestModules.filter((mod) => mod.pluginName !== pluginName)
		if (nextModules.length === this.manifestModules.length) return
		this.moduleStatesByPlugin.delete(pluginName)
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

	private getModuleStatesSnapshot(): ExtensionModuleState[] {
		const states = Array.from(this.moduleStatesByPlugin.values())
		states.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
		return states
	}

	private setModuleStateRecord(next: ExtensionModuleState): void {
		const previous = this.moduleStatesByPlugin.get(next.pluginName)
		if (
			previous &&
			previous.state === next.state &&
			previous.updatedAt === next.updatedAt &&
			previous.sourceHash === next.sourceHash &&
			previous.compiledAt === next.compiledAt &&
			previous.message === next.message
		) {
			return
		}

		this.moduleStatesByPlugin.set(next.pluginName, next)
		this.manifestVersion += 1
		if (next.state === 'building') {
			this.notifyManifest({
				type: 'building',
				version: this.manifestVersion,
				pluginName: next.pluginName,
				updatedAt: next.updatedAt,
				sourceHash: next.sourceHash,
				compiledAt: next.compiledAt,
			})
			return
		}

		if (next.state === 'error') {
			this.notifyManifest({
				type: 'error',
				version: this.manifestVersion,
				pluginName: next.pluginName,
				updatedAt: next.updatedAt,
				sourceHash: next.sourceHash,
				compiledAt: next.compiledAt,
				message: next.message ?? 'Unknown extension compile error',
			})
		}
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

	private async registerPackagedModule(
		pluginName: string,
		manifestPath?: string | null,
	): Promise<void> {
		const explicitManifestPath = String(manifestPath ?? '').trim()
		const resolvedManifestPath = this.resolvePackagedManifestPath(pluginName, manifestPath)
		if (!resolvedManifestPath) {
			if (explicitManifestPath) {
				this.ctx.logger.warn('packaged extension manifest not resolved', { pluginName })
			} else {
				this.ctx.logger.debug?.('packaged extension manifest not resolved (implicit path)', {
					pluginName,
				})
			}
			return
		}

		const [content, fileStat] = await Promise.all([
			readFile(resolvedManifestPath, 'utf-8').catch((): null => null),
			stat(resolvedManifestPath).catch((): null => null),
		])
		if (!content || !fileStat?.isFile()) {
			if (explicitManifestPath) {
				this.ctx.logger.warn('packaged extension manifest missing', {
					pluginName,
					manifestPath: resolvedManifestPath,
				})
			} else {
				this.ctx.logger.debug?.('packaged extension manifest missing (implicit path)', {
					pluginName,
					manifestPath: resolvedManifestPath,
				})
			}
			return
		}

		const sourceHash = createHash('sha256').update(content).digest('hex').slice(0, 16)
		const compiledAt = Math.floor(fileStat.mtimeMs || Date.now())
		await this.commitCompiledModule(
			createCompiledExtensionModule({
				pluginName,
				sourceHash,
				compiledAt,
			}),
			{ artifactRoot: dirname(resolvedManifestPath) },
		)
	}

	private resolvePackagedManifestPath(
		pluginName: string,
		manifestPath?: string | null,
	): string | null {
		const target = String(manifestPath ?? '').trim()
		if (target) {
			if (isAbsolute(target)) return target
			return this.resolveRelativeManifestPath(pluginName, target)
		}

		return this.resolveRelativeManifestPath(pluginName, extensionFederationManifestPath())
	}

	private resolveRelativeManifestPath(pluginName: string, relativeManifestPath: string): string | null {
		const registryPath = this.ctx.loader?.api?.registry?.findModuleIdByName?.(pluginName)
		if (registryPath) {
			const baseDir = resolveModuleIdBaseDir(registryPath)
			if (baseDir) {
				const packageRoot = findNearestPackageRoot(baseDir)
				if (packageRoot) {
					const packageRelativePath =
						relativeManifestPath === extensionFederationManifestPath()
							? extensionFederationBuildManifestPath()
							: relativeManifestPath
					return resolve(packageRoot, packageRelativePath)
				}
				return resolve(baseDir, relativeManifestPath)
			}
		}

		for (const path of this.ctx.loader?.api?.anchors?.list?.() ?? []) {
			if (path.toLowerCase().includes(pluginName.toLowerCase()) && isAbsolute(path)) {
				const baseDir = dirname(path)
				const packageRoot = findNearestPackageRoot(baseDir)
				if (packageRoot) {
					const packageRelativePath =
						relativeManifestPath === extensionFederationManifestPath()
							? extensionFederationBuildManifestPath()
							: relativeManifestPath
					return resolve(packageRoot, packageRelativePath)
				}
				return resolve(baseDir, relativeManifestPath)
			}
		}

		const cwd = process.cwd()
		const manifestPath = /(?:^|[\\/])dist$/i.test(cwd)
			? relativeManifestPath
			: relativeManifestPath === extensionFederationManifestPath()
				? extensionFederationBuildManifestPath()
				: relativeManifestPath
		return resolve(cwd, manifestPath)
	}
}

export function createCompiledExtensionModule(input: {
	pluginName: string
	sourceHash: string
	compiledAt?: number
}): CompiledExtensionModule {
	const compiledAt = input.compiledAt ?? Date.now()
	return {
		pluginName: input.pluginName,
		remoteName: extensionFederationRemoteName(input.pluginName),
		manifestUrl: `${HMR_INTERNAL_API_BASE}${hmrExtensionArtifactPath(
			input.pluginName,
			input.sourceHash,
			EXTENSION_FEDERATION_MANIFEST_FILE,
		)}`,
		exposedModule: EXTENSION_FEDERATION_EXPOSE,
		sourceHash: input.sourceHash,
		compiledAt,
	}
}

function normalizeArtifactFile(file: string): string | null {
	const cleaned = String(file ?? '')
		.trim()
		.replace(/^\/+/, '')
	if (!cleaned) return null
	if (cleaned.split('/').some((segment) => segment === '..' || segment.length === 0)) return null
	return cleaned
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	if (typeof error === 'string' && error.trim()) return error.trim()
	try {
		return JSON.stringify(error)
	} catch {
		return 'Unknown extension compile error'
	}
}
