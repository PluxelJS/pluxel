import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { Context } from '@pluxel/core'
import { dirname, resolve } from 'pathe'
import type {
	ManagementArtifactEvent,
	ManagementUiArtifact,
	ManagementUiArtifactState,
	ManagementUiSourceDeclaration,
} from '../../management/contracts'
import { runtimeDevCapabilities } from '../../runtime/capabilities'
import { findRuntimeModuleId, resolveModuleIdBaseDir } from '../../runtime/module-id'
import {
	MANAGEMENT_FEDERATION_EXPOSE,
	MANAGEMENT_FEDERATION_MANIFEST_FILE,
	MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE,
	managementFederationBuildManifestPath,
	managementFederationManifestPath,
	managementFederationModuleId,
	managementFederationRemoteName,
} from '../../management/federation'
import { RUNTIME_INTERNAL_API_BASE, runtimeManagementArtifactPath } from '../../web/paths'

export interface ManagementArtifactStore {
	getCompiledModule(pluginName: string): ManagementUiArtifact | undefined
	commitCompiledModule(
		module: ManagementUiArtifact,
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

export class ManagementArtifactService implements ManagementArtifactStore {
	private revision = 0
	private modules: ManagementUiArtifact[] = []
	private readonly states = new Map<string, ManagementUiArtifactState>()
	private readonly roots = new Map<string, { sourceHash: string; dir: string }>()
	private readonly listeners = new Set<(event: ManagementArtifactEvent) => void>()

	constructor(private readonly root: Context) {}

	registerFor(owner: Context, declaration: ManagementUiSourceDeclaration): () => void {
		const sourceBinder = runtimeDevCapabilities(owner)?.managementUiSource?.bind
		if (sourceBinder) return sourceBinder(owner, declaration)
		return this.registerPackaged(owner)
	}

	subscribe(listener: (event: ManagementArtifactEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getCatalog(): {
		revision: number
		modules: readonly ManagementUiArtifact[]
		states: readonly ManagementUiArtifactState[]
	} {
		return {
			revision: this.revision,
			modules: [...this.modules],
			states: [...this.states.values()].sort((a, b) => a.pluginName.localeCompare(b.pluginName)),
		}
	}

	getCompiledModule(pluginName: string): ManagementUiArtifact | undefined {
		return this.modules.find((module) => module.pluginName === pluginName)
	}

	async commitCompiledModule(
		module: ManagementUiArtifact,
		options?: { artifactRoot?: string | null },
	): Promise<void> {
		if (options?.artifactRoot) {
			this.roots.set(module.pluginName, {
				sourceHash: module.sourceHash,
				dir: options.artifactRoot,
			})
		}
		const previous = this.getCompiledModule(module.pluginName)
		if (
			previous?.sourceHash === module.sourceHash &&
			previous.compiledAt === module.compiledAt &&
			this.states.get(module.pluginName)?.state === 'ready'
		) {
			return
		}
		this.modules = this.modules.filter((item) => item.pluginName !== module.pluginName)
		this.modules.push(module)
		this.modules.sort((a, b) => a.pluginName.localeCompare(b.pluginName))
		this.states.set(module.pluginName, {
			pluginName: module.pluginName,
			state: 'ready',
			updatedAt: module.compiledAt,
			sourceHash: module.sourceHash,
			compiledAt: module.compiledAt,
		})
		this.emit({ type: 'update', ...module, revision: this.nextRevision() })
	}

	async markCompiling(
		pluginName: string,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void> {
		const state: ManagementUiArtifactState = {
			pluginName,
			state: 'building',
			updatedAt: options?.updatedAt ?? Date.now(),
			sourceHash: options?.sourceHash,
			compiledAt: options?.compiledAt,
		}
		this.states.set(pluginName, state)
		this.emit({ type: 'building', revision: this.nextRevision(), ...state })
	}

	async markCompileError(
		pluginName: string,
		error: unknown,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void> {
		const state: ManagementUiArtifactState = {
			pluginName,
			state: 'error',
			updatedAt: options?.updatedAt ?? Date.now(),
			sourceHash: options?.sourceHash,
			compiledAt: options?.compiledAt,
			message: errorMessage(error),
		}
		this.states.set(pluginName, state)
		this.emit({
			type: 'error',
			revision: this.nextRevision(),
			pluginName,
			updatedAt: state.updatedAt,
			sourceHash: state.sourceHash,
			compiledAt: state.compiledAt,
			message: state.message ?? 'Unknown management UI build error',
		})
	}

	async removePlugin(pluginName: string): Promise<void> {
		this.roots.delete(pluginName)
		this.states.delete(pluginName)
		const next = this.modules.filter((item) => item.pluginName !== pluginName)
		if (next.length === this.modules.length) return
		this.modules = next
		this.emit({ type: 'remove', revision: this.nextRevision(), pluginName })
	}

	resolveArtifactFile(pluginName: string, sourceHash: string, file: string): string | null {
		const normalized = normalizeArtifactFile(file)
		if (!normalized) return null
		const stored = this.roots.get(pluginName)
		const baseDir = stored?.sourceHash === sourceHash ? stored.dir : null
		if (!baseDir) return null
		const fullPath = resolve(baseDir, normalized)
		if (fullPath !== baseDir && !fullPath.startsWith(`${baseDir}/`)) return null
		return fullPath
	}

	private registerPackaged(owner: Context): () => void {
		const pluginName = owner.pluginInfo.id
		let disposed = false
		void this.registerPackagedModule(pluginName).catch((error) => {
			if (!disposed) owner.logger.error('failed to register management UI artifact', { error })
		})
		const guard = owner.effects.defer(() => {
			disposed = true
			void this.removePlugin(pluginName)
		})
		return () => guard.dispose()
	}

	private async registerPackagedModule(pluginName: string): Promise<void> {
		const manifestPath = this.resolvePackagedManifestPath(pluginName)
		if (!manifestPath) return
		const [content, fileStat] = await Promise.all([
			readFile(manifestPath, 'utf8').catch((): null => null),
			stat(manifestPath).catch((): null => null),
		])
		if (!content || !fileStat?.isFile()) return
		const artifactRoot = dirname(manifestPath)
		const remoteEntry = await readFile(
			resolve(artifactRoot, MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE),
		).catch((): null => null)
		if (!remoteEntry) {
			throw new Error(`incomplete management UI artifact for ${pluginName}: remoteEntry.js missing`)
		}
		await validatePackagedManifest(artifactRoot, pluginName, content)
		const sourceHash = createHash('sha256')
			.update(content)
			.update(remoteEntry)
			.digest('hex')
			.slice(0, 16)
		await this.commitCompiledModule(
			createCompiledManagementArtifact({
				pluginName,
				sourceHash,
				compiledAt: Math.floor(fileStat.mtimeMs || Date.now()),
			}),
			{ artifactRoot },
		)
	}

	private resolvePackagedManifestPath(pluginName: string): string | null {
		const registryPath = findRuntimeModuleId(this.root, pluginName)
		if (registryPath) {
			const baseDir = resolveModuleIdBaseDir(registryPath)
			if (baseDir) {
				const packageRoot = findNearestPackageRoot(baseDir)
				return resolve(
					packageRoot ?? baseDir,
					packageRoot
						? managementFederationBuildManifestPath(pluginName)
						: managementFederationManifestPath(pluginName),
				)
			}
		}
		const cwd = process.cwd()
		return resolve(
			cwd,
			/(?:^|[\\/])dist$/i.test(cwd)
				? managementFederationManifestPath(pluginName)
				: managementFederationBuildManifestPath(pluginName),
		)
	}

	private nextRevision(): number {
		this.revision += 1
		return this.revision
	}

	private emit(event: ManagementArtifactEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (error) {
				this.root.logger.error('management artifact listener failed', { error })
			}
		}
	}
}

async function validatePackagedManifest(
	artifactRoot: string,
	pluginName: string,
	content: string,
): Promise<void> {
	type AssetGroup = {
		js?: { sync?: string[]; async?: string[] }
		css?: { sync?: string[]; async?: string[] }
	}
	type Manifest = {
		name?: string
		metaData?: { name?: string; remoteEntry?: { name?: string } }
		exposes?: Array<{ name?: string; assets?: AssetGroup }>
	}
	let manifest: Manifest
	try {
		manifest = JSON.parse(content) as Manifest
	} catch (error) {
		throw new Error(`invalid management UI manifest for ${pluginName}`, { cause: error })
	}
	if (manifest.metaData?.remoteEntry?.name !== MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE) {
		throw new Error(`invalid management UI remote entry for ${pluginName}`)
	}
	const expectedName = managementFederationRemoteName(pluginName)
	const actualName = manifest.name ?? manifest.metaData?.name
	if (actualName && actualName !== expectedName) {
		throw new Error(
			`management UI artifact owner mismatch: expected ${expectedName}, got ${actualName}`,
		)
	}
	const exposeName = managementFederationModuleId(MANAGEMENT_FEDERATION_EXPOSE)
	const expose = manifest.exposes?.find(
		(item) => item.name === MANAGEMENT_FEDERATION_EXPOSE || item.name === exposeName,
	)
	if (!expose) throw new Error(`management UI expose missing for ${pluginName}`)
	const files = [
		...(expose.assets?.js?.sync ?? []),
		...(expose.assets?.js?.async ?? []),
		...(expose.assets?.css?.sync ?? []),
		...(expose.assets?.css?.async ?? []),
	]
	for (const file of files) {
		const normalized = normalizeArtifactFile(file)
		if (!normalized) throw new Error(`invalid management UI asset path for ${pluginName}: ${file}`)
		const fileStat = await stat(resolve(artifactRoot, normalized)).catch((): null => null)
		if (!fileStat?.isFile()) {
			throw new Error(`management UI asset missing for ${pluginName}: ${normalized}`)
		}
	}
}

export function createCompiledManagementArtifact(input: {
	pluginName: string
	sourceHash: string
	compiledAt?: number
}): ManagementUiArtifact {
	const compiledAt = input.compiledAt ?? Date.now()
	return {
		pluginName: input.pluginName,
		remoteName: managementFederationRemoteName(input.pluginName),
		manifestUrl: `${RUNTIME_INTERNAL_API_BASE}${runtimeManagementArtifactPath(
			input.pluginName,
			input.sourceHash,
			MANAGEMENT_FEDERATION_MANIFEST_FILE,
		)}`,
		exposedModule: MANAGEMENT_FEDERATION_EXPOSE,
		sourceHash: input.sourceHash,
		compiledAt,
	}
}

function findNearestPackageRoot(start: string): string | null {
	let current = start
	while (true) {
		if (existsSync(resolve(current, 'package.json'))) return current
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
}

function normalizeArtifactFile(file: string): string | null {
	const cleaned = String(file ?? '')
		.trim()
		.replace(/^\/+/, '')
	if (!cleaned || cleaned.split('/').some((part) => !part || part === '..')) return null
	return cleaned
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	if (typeof error === 'string' && error.trim()) return error.trim()
	return 'Unknown management UI build error'
}
