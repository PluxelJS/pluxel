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
	InteractionContract,
	InteractionOfferDef,
	InteractionSurfaceDef,
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
import { ExtensionInteractionRegistry } from './ExtensionInteractionRegistry'
import {
	errorMessage,
	type InteractionOfferPrepareContext,
	type InteractionOfferPrepareResult,
	type InteractionSurfaceApplyContext,
	type InteractionSurfaceRuntimeContext,
	normalizeInteractionContractRef,
	type RegisteredOffer,
	type RegisteredSurface,
	stripRuntime,
} from './ExtensionService.shared'

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

type TypedInteractionSurfaceRuntimeContext<TInput> = Omit<InteractionSurfaceRuntimeContext, 'input'> & {
	input: TInput
}

type TypedInteractionSurfaceApplyContext<TInput, TDraft> = Omit<
	InteractionSurfaceApplyContext,
	'input' | 'draft'
> & {
	input: TInput
	draft: TDraft
}

type TypedInteractionOfferPrepareContext<TInput> = Omit<InteractionOfferPrepareContext, 'input'> & {
	input: TInput
}

type TypedInteractionOfferPrepareResult<TDraft, TPrepared> = {
	draft?: TDraft
	prepared?: TPrepared
}

export class ExtensionService implements ExtensionModuleStore {
	private enabled = true
	private manifestVersion = 0
	private manifestModules: CompiledExtensionModule[] = []
	private readonly moduleStatesByPlugin = new Map<string, ExtensionModuleState>()
	private readonly artifactRootsByPlugin = new Map<string, { sourceHash: string; dir: string }>()
	private readonly manifestListeners = new Set<(event: ExtensionManifestEvent) => void>()
	private readonly interactions: ExtensionInteractionRegistry
	readonly remote = {
		packaged: (input?: { manifestPath?: string | null }) => this.packaged(input),
	}
	readonly builtin = {
		doc: <P extends ExtensionPoint = 'plugin:tabs'>(
			input: Omit<BuiltinDocExtensionDef<P>, 'kind' | 'pluginName' | 'point'> & { point?: P },
		) => this.doc(input),
	}
	readonly interaction = {
		surface: <
			P extends ExtensionPoint = 'plugin:tabs',
			TInput = unknown,
			TDraft = unknown,
			TResult = unknown,
		>(
			input: Omit<InteractionSurfaceDef<P>, 'pluginName' | 'point' | 'contract'> & {
				point?: P
				contract: InteractionContract<TInput, TDraft, TResult>
				input?: () => TInput | Promise<TInput>
				onDraftChange?: (
					draft: TDraft,
					context: TypedInteractionSurfaceRuntimeContext<TInput>,
				) => unknown | Promise<unknown>
				apply: (
					result: TResult,
					context: TypedInteractionSurfaceApplyContext<TInput, TDraft>,
				) => unknown | Promise<unknown>
			},
		) => this.surface(input),
		offer: <
			P extends ExtensionPoint = 'plugin:tabs',
			TInput = unknown,
			TDraft = unknown,
			TResult = unknown,
			TPrepared = unknown,
		>(
			input: Omit<InteractionOfferDef<P>, 'pluginName' | 'point' | 'contract'> & {
				point?: P
				contract: InteractionContract<TInput, TDraft, TResult>
				prepare?: (
					context: TypedInteractionOfferPrepareContext<TInput>,
				) =>
					| TypedInteractionOfferPrepareResult<TDraft, TPrepared>
					| Promise<TypedInteractionOfferPrepareResult<TDraft, TPrepared>>
				renderKey: string
			},
		) => this.offer(input),
	}

	constructor(
		public ctx: Context,
		config?: ExtensionServiceConfig,
	) {
		this.interactions = new ExtensionInteractionRegistry(ctx)
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
		this.syncInteractionContext()
		if (!this.enabled)
			return {
				version: 0,
				modules: [],
				builtins: [],
				surfaces: [],
				offers: [],
				sessions: [],
				interactions: [],
				states: [],
			}
		const resolved = this.interactions.getSnapshot()
		return {
			version: this.manifestVersion,
			modules: this.manifestModules.slice(),
			builtins: resolved.builtins,
			surfaces: resolved.surfaces,
			offers: resolved.offers,
			sessions: resolved.sessions,
			interactions: resolved.interactions,
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
		this.syncInteractionContext()
		this.artifactRootsByPlugin.delete(pluginName)
		this.moduleStatesByPlugin.delete(pluginName)
		this.interactions.clearPlugin(pluginName)
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
		this.syncInteractionContext()
		const currentPluginName = this.ctx.pluginInfo.id
		const id = String(def.id ?? '').trim()
		const point = String(def.point ?? '').trim()
		const kind = String(def.kind ?? '').trim()
		if (!id) throw new Error('[ExtensionService] registerBuiltin: id required')
		if (!kind) throw new Error('[ExtensionService] registerBuiltin: kind required')
		const normalized: BuiltinExtensionDef = {
			...def,
			id,
			point: point as ExtensionPoint,
			kind: kind as BuiltinExtensionDef['kind'],
			pluginName: currentPluginName,
		}
		try {
			JSON.stringify(normalized)
		} catch (_err) {
			throw new Error(
				`[ExtensionService] registerBuiltin: def must be JSON-serializable (id=${id}, point=${point}, kind=${kind})`,
			)
		}

		this.interactions.addBuiltin(normalized)
		const guard = this.ctx.effects.defer(() => {
			if (this.interactions.removeBuiltin(normalized)) {
				this.bumpManifestSync()
			}
		})
		this.bumpManifestSync()
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

	surface<P extends ExtensionPoint = 'plugin:tabs', TInput = unknown, TDraft = unknown, TResult = unknown>(
		input: Omit<InteractionSurfaceDef<P>, 'pluginName' | 'point' | 'contract'> & {
			point?: P
			contract: InteractionContract<TInput, TDraft, TResult>
			input?: () => TInput | Promise<TInput>
			onDraftChange?: (
				draft: TDraft,
				context: TypedInteractionSurfaceRuntimeContext<TInput>,
			) => unknown | Promise<unknown>
			apply: (
				result: TResult,
				context: TypedInteractionSurfaceApplyContext<TInput, TDraft>,
			) => unknown | Promise<unknown>
		},
	): () => void {
		if (!this.enabled) return () => undefined
		this.syncInteractionContext()
		const pluginName = this.ctx.pluginInfo.id
		const point = (input.point ?? ('plugin:tabs' as P)) as P
		const id = String(input.id ?? '').trim()
		if (!id) throw new Error('[ExtensionService] surface: id required')
		if (typeof input.apply !== 'function') {
			throw new Error('[ExtensionService] surface: apply(result, ctx) required')
		}

		const normalized: RegisteredSurface = {
			...(input as Omit<InteractionSurfaceDef<P>, 'pluginName' | 'point' | 'contract'>),
			id,
			pluginName,
			point,
			contract: normalizeInteractionContractRef(input.contract),
			providers: Array.isArray(input.providers)
				? input.providers.map((item) => String(item ?? '').trim()).filter(Boolean)
				: input.providers === null
					? null
					: undefined,
			cardinality: input.cardinality === 'multiple' ? 'multiple' : 'single',
			runtime: {
				contract: input.contract,
				input: input.input as (() => unknown | Promise<unknown>) | undefined,
				onDraftChange: input.onDraftChange as
					| ((draft: unknown, context: InteractionSurfaceRuntimeContext) => unknown | Promise<unknown>)
					| undefined,
				apply: input.apply as (
					result: unknown,
					context: InteractionSurfaceApplyContext,
				) => unknown | Promise<unknown>,
			},
		}

		try {
			JSON.stringify(stripRuntime(normalized))
		} catch (_err) {
			throw new Error(
				`[ExtensionService] surface: def must be JSON-serializable (id=${id}, point=${String(
					normalized.point,
				)})`,
			)
		}

		this.interactions.addSurface(normalized)
		try {
			JSON.stringify(normalized.contract)
		} catch {
			throw new Error('[ExtensionService] surface: contract metadata must be JSON-serializable')
		}
		const guard = this.ctx.effects.defer(() => {
			if (this.interactions.removeSurface(normalized)) {
				this.bumpManifestSync()
			}
		})
		this.bumpManifestSync()
		return () => guard.dispose()
	}

	offer<
		P extends ExtensionPoint = 'plugin:tabs',
		TInput = unknown,
		TDraft = unknown,
		TResult = unknown,
		TPrepared = unknown,
	>(
		input: Omit<InteractionOfferDef<P>, 'pluginName' | 'point' | 'contract'> & {
			point?: P
			contract: InteractionContract<TInput, TDraft, TResult>
			prepare?: (
				context: TypedInteractionOfferPrepareContext<TInput>,
			) =>
				| TypedInteractionOfferPrepareResult<TDraft, TPrepared>
				| Promise<TypedInteractionOfferPrepareResult<TDraft, TPrepared>>
		},
	): () => void {
		if (!this.enabled) return () => undefined
		this.syncInteractionContext()
		const pluginName = this.ctx.pluginInfo.id
		const point = (input.point ?? ('plugin:tabs' as P)) as P
		const id = String(input.id ?? '').trim()
		const renderKey = String(input.renderKey ?? '').trim()
		if (!id) throw new Error('[ExtensionService] offer: id required')
		if (!renderKey) throw new Error('[ExtensionService] offer: renderKey required')

		const normalized: RegisteredOffer = {
			...(input as Omit<InteractionOfferDef<P>, 'pluginName' | 'point' | 'contract'>),
			id,
			pluginName,
			point,
			renderKey,
			contract: normalizeInteractionContractRef(input.contract),
			targets: Array.isArray(input.targets)
				? input.targets.map((item) => String(item ?? '').trim()).filter(Boolean)
				: input.targets === null
					? null
					: undefined,
			runtime: {
				contract: input.contract,
				prepare: input.prepare as
					| ((context: InteractionOfferPrepareContext) => InteractionOfferPrepareResult | Promise<InteractionOfferPrepareResult>)
					| undefined,
			},
		}

		try {
			JSON.stringify(stripRuntime(normalized))
		} catch (_err) {
			throw new Error(
				`[ExtensionService] offer: def must be JSON-serializable (id=${id}, point=${String(
					normalized.point,
				)}, renderKey=${renderKey})`,
			)
		}
		this.interactions.addOffer(normalized)
		const guard = this.ctx.effects.defer(() => {
			if (this.interactions.removeOffer(normalized)) {
				this.bumpManifestSync()
			}
		})
		this.bumpManifestSync()
		return () => guard.dispose()
	}

	async loadSession(sessionId: string) {
		this.syncInteractionContext()
		return await this.interactions.loadSession(sessionId)
	}

	async syncDraft(input: { sessionId: string; draft: unknown }) {
		this.syncInteractionContext()
		return await this.interactions.syncDraft(input)
	}

	async commitSession(input: { sessionId: string; result: unknown }) {
		this.syncInteractionContext()
		return await this.interactions.commitSession(input)
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

	private syncInteractionContext(): void {
		this.interactions.setContext(this.ctx)
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

	private resolveRelativeManifestPath(
		pluginName: string,
		relativeManifestPath: string,
	): string | null {
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
