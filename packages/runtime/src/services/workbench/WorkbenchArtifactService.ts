import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { pluginNodeIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import { dirname, resolve } from 'pathe'
import type { RuntimeContextConfig } from '../../context-augment'
import type {
	WorkbenchBundleEvent,
	WorkbenchBundle,
	WorkbenchBundleState,
	WorkbenchPluginDescriptor,
} from '../../workbench/contracts'
import { readWorkbenchUiEntry, type WorkbenchUiEntry } from '../../workbench/ui-entry'
import {
	WORKBENCH_FEDERATION_EXPOSE,
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
	sanitizeWorkbenchOwnerName,
	workbenchFederationModuleId,
	workbenchFederationRemoteName,
} from '@pluxel/core/federation'
import { RUNTIME_INTERNAL_API_BASE, runtimeWorkbenchArtifactPath } from '../../web/paths'
import { pluginNodePhysicalKey } from '../../runtime/plugin-address'

type WorkbenchSourceBinder = (
	owner: Context,
	declaration: WorkbenchUiEntry,
	contractFingerprint: string,
) => () => void

type WorkbenchArtifactContext = Context & {
	readonly config: Context['config'] & RuntimeContextConfig
}

export class WorkbenchArtifactService {
	private revision = 0
	private readonly bundles = new Map<string, WorkbenchBundle>()
	private readonly states = new Map<string, WorkbenchBundleState>()
	private readonly roots = new Map<string, { sourceHash: string; dir: string }>()
	private readonly listeners = new Set<(event: WorkbenchBundleEvent) => void>()
	private sourceBinder?: WorkbenchSourceBinder

	constructor(private readonly root: WorkbenchArtifactContext) {}

	attachSourceBinder(sourceBinder: WorkbenchSourceBinder): () => void {
		if (this.sourceBinder) {
			throw new Error('[pluxel/runtime] Workbench source compiler is already attached.')
		}
		this.sourceBinder = sourceBinder
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.sourceBinder === sourceBinder) this.sourceBinder = undefined
		}
	}

	registerFor(
		owner: Context,
		declaration: WorkbenchUiEntry,
		contractFingerprint: string,
	): () => void {
		if (this.sourceBinder) return this.sourceBinder(owner, declaration, contractFingerprint)
		return this.registerPackaged(owner, declaration)
	}

	subscribe(listener: (event: WorkbenchBundleEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getCatalog(): {
		revision: number
		bundles: readonly WorkbenchBundle[]
		states: readonly WorkbenchBundleState[]
	} {
		return {
			revision: this.revision,
			bundles: [...this.bundles.values()].sort(compareBundleOwner),
			states: [...this.states.values()].sort(compareBundleOwner),
		}
	}

	getCompiledModule(owner: PluginNodeAddress): WorkbenchBundle | undefined {
		return this.bundles.get(pluginNodeIndexKey(owner))
	}

	async commitCompiledModule(
		module: WorkbenchBundle,
		options?: { artifactRoot?: string | null },
	): Promise<void> {
		const ownerKey = pluginNodeIndexKey(module.owner.address)
		if (options?.artifactRoot) {
			this.roots.set(workbenchArtifactOwnerKey(module.owner.address), {
				sourceHash: module.sourceHash,
				dir: options.artifactRoot,
			})
		}
		const previous = this.getCompiledModule(module.owner.address)
		if (
			previous?.sourceHash === module.sourceHash &&
			previous.compiledAt === module.compiledAt &&
			this.states.get(ownerKey)?.state === 'ready'
		) {
			return
		}
		this.bundles.set(ownerKey, module)
		this.states.set(ownerKey, {
			owner: module.owner,
			state: 'ready',
			updatedAt: module.compiledAt,
			sourceHash: module.sourceHash,
			compiledAt: module.compiledAt,
		})
		this.emit({ type: 'update', ...module, revision: this.nextRevision() })
	}

	async markCompiling(
		owner: WorkbenchPluginDescriptor,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void> {
		const state: WorkbenchBundleState = {
			owner,
			state: 'building',
			updatedAt: options?.updatedAt ?? Date.now(),
			sourceHash: options?.sourceHash,
			compiledAt: options?.compiledAt,
		}
		this.states.set(pluginNodeIndexKey(owner.address), state)
		this.emit({ type: 'building', revision: this.nextRevision(), ...state })
	}

	async markCompileError(
		owner: WorkbenchPluginDescriptor,
		error: unknown,
		options?: { updatedAt?: number; sourceHash?: string; compiledAt?: number },
	): Promise<void> {
		const state: WorkbenchBundleState = {
			owner,
			state: 'error',
			updatedAt: options?.updatedAt ?? Date.now(),
			sourceHash: options?.sourceHash,
			compiledAt: options?.compiledAt,
			message: errorMessage(error),
		}
		this.states.set(pluginNodeIndexKey(owner.address), state)
		this.emit({
			type: 'error',
			revision: this.nextRevision(),
			owner,
			updatedAt: state.updatedAt,
			sourceHash: state.sourceHash,
			compiledAt: state.compiledAt,
			message: state.message ?? 'Unknown workbench UI build error',
		})
	}

	async removePlugin(owner: WorkbenchPluginDescriptor): Promise<void> {
		const ownerKey = pluginNodeIndexKey(owner.address)
		this.roots.delete(workbenchArtifactOwnerKey(owner.address))
		this.states.delete(ownerKey)
		if (!this.bundles.delete(ownerKey)) return
		this.emit({ type: 'remove', revision: this.nextRevision(), owner })
	}

	resolveArtifactFile(ownerKey: string, sourceHash: string, file: string): string | null {
		const normalized = normalizeArtifactFile(file)
		if (!normalized) return null
		const stored = this.roots.get(ownerKey)
		const baseDir = stored?.sourceHash === sourceHash ? stored.dir : null
		if (!baseDir) return null
		const fullPath = resolve(baseDir, normalized)
		if (fullPath !== baseDir && !fullPath.startsWith(`${baseDir}/`)) return null
		return fullPath
	}

	private registerPackaged(owner: Context, declaration: WorkbenchUiEntry): () => void {
		const ownerDescriptor: WorkbenchPluginDescriptor = Object.freeze({
			address: owner.pluginInfo.nodeAddress,
			displayName: owner.pluginInfo.displayName,
			rootExportName: owner.pluginInfo.definitionAddress.exportName,
		})
		const uiEntry = readWorkbenchUiEntry(declaration)
		let disposed = false
		void this.registerPackagedModule(
			ownerDescriptor,
			uiEntry.artifactKey ?? workbenchArtifactOwnerKey(ownerDescriptor.address),
			() => disposed,
		).catch((error) => {
			if (!disposed) {
				void this.markCompileError(ownerDescriptor, error)
				owner.logger.error('failed to register workbench UI artifact', { error })
			}
		})
		const guard = owner.effects.defer(() => {
			disposed = true
			void this.removePlugin(ownerDescriptor)
		})
		return () => guard.dispose()
	}

	private async registerPackagedModule(
		owner: WorkbenchPluginDescriptor,
		artifactName: string,
		isDisposed: () => boolean,
	): Promise<void> {
		const manifestPath = await this.resolvePackagedManifestPath(owner.address, artifactName)
		if (!manifestPath || isDisposed()) {
			if (!isDisposed()) {
				throw new Error(`packaged workbench UI artifact not found: ${artifactName}`)
			}
			return
		}
		const [content, fileStat] = await Promise.all([
			readFile(manifestPath, 'utf8').catch((): null => null),
			stat(manifestPath).catch((): null => null),
		])
		if (!content || !fileStat?.isFile()) {
			throw new Error(`packaged workbench UI manifest not found: ${manifestPath}`)
		}
		const artifactRoot = dirname(manifestPath)
		const remoteEntry = await readFile(
			resolve(artifactRoot, WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE),
		).catch((): null => null)
		if (!remoteEntry) {
			throw new Error(
				`incomplete workbench UI artifact for ${owner.displayName}: remoteEntry.js missing`,
			)
		}
		await validatePackagedManifest(artifactRoot, artifactName, content)
		if (isDisposed()) return
		const sourceHash = createHash('sha256')
			.update(content)
			.update(remoteEntry)
			.digest('hex')
			.slice(0, 16)
		await this.commitCompiledModule(
			createCompiledWorkbenchArtifact({
				owner,
				artifactName,
				sourceHash,
				compiledAt: Math.floor(fileStat.mtimeMs || Date.now()),
			}),
			{ artifactRoot },
		)
	}

	private async resolvePackagedManifestPath(
		owner: PluginNodeAddress,
		artifactName: string,
	): Promise<string | null> {
		const deploymentRoot = String(this.root.config.workbenchArtifactRoot ?? '').trim()
		if (deploymentRoot) {
			return resolveDeploymentWorkbenchManifestPath(deploymentRoot, artifactName)
		}
		return (
			(await this.root.config.workbenchArtifactResolver?.(this.root, owner, artifactName)) ?? null
		)
	}

	private nextRevision(): number {
		this.revision += 1
		return this.revision
	}

	private emit(event: WorkbenchBundleEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (error) {
				this.root.logger.error('workbench artifact listener failed', { error })
			}
		}
	}
}

export function resolveDeploymentWorkbenchManifestPath(
	deploymentRoot: string,
	artifactName: string,
): string {
	return resolve(
		deploymentRoot,
		sanitizeWorkbenchOwnerName(artifactName),
		WORKBENCH_FEDERATION_MANIFEST_FILE,
	)
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
		throw new Error(`invalid workbench UI manifest for ${pluginName}`, { cause: error })
	}
	if (manifest.metaData?.remoteEntry?.name !== WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE) {
		throw new Error(`invalid workbench UI remote entry for ${pluginName}`)
	}
	const expectedName = workbenchFederationRemoteName(pluginName)
	const actualName = manifest.name ?? manifest.metaData?.name
	if (actualName && actualName !== expectedName) {
		throw new Error(
			`workbench UI artifact owner mismatch: expected ${expectedName}, got ${actualName}`,
		)
	}
	const exposeName = workbenchFederationModuleId(WORKBENCH_FEDERATION_EXPOSE)
	const expose = manifest.exposes?.find(
		(item) => item.name === WORKBENCH_FEDERATION_EXPOSE || item.name === exposeName,
	)
	if (!expose) throw new Error(`workbench UI expose missing for ${pluginName}`)
	const files = [
		...(expose.assets?.js?.sync ?? []),
		...(expose.assets?.js?.async ?? []),
		...(expose.assets?.css?.sync ?? []),
		...(expose.assets?.css?.async ?? []),
	]
	for (const file of files) {
		const normalized = normalizeArtifactFile(file)
		if (!normalized) throw new Error(`invalid workbench UI asset path for ${pluginName}: ${file}`)
		const fileStat = await stat(resolve(artifactRoot, normalized)).catch((): null => null)
		if (!fileStat?.isFile()) {
			throw new Error(`workbench UI asset missing for ${pluginName}: ${normalized}`)
		}
	}
}

export function createCompiledWorkbenchArtifact(input: {
	owner: WorkbenchPluginDescriptor
	artifactName?: string
	sourceHash: string
	compiledAt?: number
}): WorkbenchBundle {
	const compiledAt = input.compiledAt ?? Date.now()
	const ownerKey = workbenchArtifactOwnerKey(input.owner.address)
	return {
		owner: input.owner,
		remoteName: workbenchFederationRemoteName(input.artifactName ?? ownerKey),
		remoteEntryUrl: `${RUNTIME_INTERNAL_API_BASE}${runtimeWorkbenchArtifactPath(
			ownerKey,
			input.sourceHash,
			WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
		)}`,
		exposedModule: WORKBENCH_FEDERATION_EXPOSE,
		sourceHash: input.sourceHash,
		compiledAt,
	}
}

/** Opaque physical URL index. Workbench identity remains the structured address in its DTO. */
export function workbenchArtifactOwnerKey(owner: PluginNodeAddress): string {
	return pluginNodePhysicalKey(owner)
}

function compareBundleOwner(
	left: { owner: WorkbenchPluginDescriptor },
	right: { owner: WorkbenchPluginDescriptor },
): number {
	return pluginNodeIndexKey(left.owner.address).localeCompare(
		pluginNodeIndexKey(right.owner.address),
	)
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
	return 'Unknown workbench UI build error'
}
