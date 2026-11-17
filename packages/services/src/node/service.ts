import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { pluginDefinitionIndexKey, type Context as CoreContext } from '@pluxel/core'
import { pinOwnerContext } from '../internal/owner-view'
import {
	readNodeModuleDeclaration,
	type NodeModuleCleanup,
	type NodeModuleDeclaration,
	type NodeModuleSetup,
} from './declaration'

export type NodeModuleSourceSubscription = Readonly<{
	url: URL
	dispose(): void | Promise<void>
}>

export type NodeModuleSourceBinder = (
	declaration: NodeModuleDeclaration,
	onUpdate: (url: URL) => void | Promise<void>,
	onError: (error: unknown) => void,
) => Promise<NodeModuleSourceSubscription>

type RootState = {
	sourceBinder?: NodeModuleSourceBinder
	loadedArtifacts?: ReadonlyMap<string, ReadonlyMap<string, string>>
	artifacts: NodeModuleArtifactHostOptions
}

export type NodeModuleArtifactHostOptions = Readonly<{
	root?: string
	resolve?: (
		root: CoreContext,
		owner: import('@pluxel/core').PluginNodeAddress,
		artifactKey: string,
	) => string | null | Promise<string | null>
}>

type ConsumerLease = {
	active: boolean
	generation: number
	requested?: URL
	activeCleanup?: NodeModuleCleanup
	updateTask?: Promise<void>
	sourceDispose?: () => void | Promise<void>
}

export class NodeModuleService {
	private readonly shared: RootState
	constructor(
		public readonly ctx: CoreContext,
		options?: NodeModuleArtifactHostOptions,
		shared?: RootState,
	) {
		pinOwnerContext(this, ctx)
		this.shared = shared ?? { artifacts: options ?? Object.freeze({}) }
	}

	forOwner(owner: CoreContext): NodeModuleService {
		return owner === this.ctx ? this : new NodeModuleService(owner, undefined, this.shared)
	}

	/** @internal Explicit artifact configuration must not be replaced by automatic source compilation. */
	get hasArtifactConfiguration(): boolean {
		return this.shared.artifacts.root !== undefined || this.shared.artifacts.resolve !== undefined
	}

	async use(declaration: NodeModuleDeclaration, setup: NodeModuleSetup): Promise<void> {
		if (typeof setup !== 'function') {
			throw new TypeError('[pluxel/runtime] nodeModules.use() requires a setup callback')
		}
		const lease: ConsumerLease = { active: true, generation: 0 }
		const guard = this.ctx.effects.defer(() => this.disposeLease(lease), {
			tag: 'NodeModule',
		})
		try {
			const binder = this.rootState().sourceBinder
			const loaded = this.shared.loadedArtifacts?.has(
				pluginDefinitionIndexKey(this.ctx.pluginInfo!.nodeAddress.definition),
			)
			if (binder && !loaded) {
				const subscription = await binder(
					declaration,
					(url) => this.requestUpdate(lease, setup, url, false),
					(error) => this.reportUpdateError(error),
				)
				if (!lease.active) {
					await subscription.dispose()
					throw new Error('[pluxel/runtime] Node module owner stopped during setup')
				}
				lease.sourceDispose = subscription.dispose
				await this.requestUpdate(lease, setup, subscription.url, true)
				return
			}

			const url = await this.resolvePackagedUrl(declaration)
			await this.requestUpdate(lease, setup, url, true)
		} catch (error) {
			const [cleanup] = await Promise.allSettled([guard.disposeAsync()])
			if (cleanup.status === 'rejected')
				throw new AggregateError(
					[error, cleanup.reason],
					'[pluxel/runtime] Node module setup and cleanup failed',
					{ cause: error },
				)
			throw error
		}
	}

	/** @internal Install the single development source provider for this runtime root. */
	attachSourceBinder(sourceBinder: NodeModuleSourceBinder): () => void {
		if (this.ctx !== this.ctx.root) {
			throw new Error('[pluxel/runtime] Node module source provider must attach to root Context')
		}
		const state = this.rootState()
		if (state.sourceBinder) {
			throw new Error('[pluxel/runtime] Node module source provider is already attached')
		}
		state.sourceBinder = sourceBinder
		let active = true
		return () => {
			if (!active) return
			active = false
			if (state.sourceBinder === sourceBinder) state.sourceBinder = undefined
		}
	}

	/** @internal Startup attaches verified inventory URLs, without a source binder or watcher. */
	installLoadedArtifacts(artifacts: ReadonlyMap<string, ReadonlyMap<string, string>>): void {
		if (this.ctx !== this.ctx.root)
			throw new TypeError('[node] loaded inventories belong to the root')
		this.shared.loadedArtifacts = artifacts
	}

	private rootState(): RootState {
		return this.shared
	}

	private async resolvePackagedUrl(declaration: NodeModuleDeclaration): Promise<URL> {
		const descriptor = readNodeModuleDeclaration(declaration)
		if (!descriptor.artifactKey) {
			throw new Error(
				`[pluxel/runtime] Node module ${descriptor.entryPath} has no packaged artifact and no development compiler is attached`,
			)
		}
		const root = this.ctx.root
		const artifacts = this.rootState().artifacts
		const configuredRoot = artifacts.root ?? ''
		const loadedFile = this.shared.loadedArtifacts
			?.get(pluginDefinitionIndexKey(this.ctx.pluginInfo!.nodeAddress.definition))
			?.get(descriptor.artifactKey)
		const file = configuredRoot
			? `${configuredRoot.replace(/[\\/]$/, '')}/${descriptor.artifactKey}.mjs`
			: ((await artifacts.resolve?.(
					root,
					this.ctx.pluginInfo!.nodeAddress,
					descriptor.artifactKey,
				)) ?? loadedFile)
		if (!file) {
			throw new Error(
				`[pluxel/runtime] packaged Node module artifact not found: ${descriptor.artifactKey}`,
			)
		}
		const fileStat = await stat(file).catch((): null => null)
		if (!fileStat?.isFile()) {
			throw new Error(`[pluxel/runtime] packaged Node module artifact not found: ${file}`)
		}
		return pathToFileURL(file)
	}

	private requestUpdate(
		lease: ConsumerLease,
		setup: NodeModuleSetup,
		url: URL,
		initial: boolean,
	): Promise<void> {
		if (!lease.active) return Promise.resolve()
		lease.requested = url
		lease.generation++
		if (!lease.updateTask) {
			lease.updateTask = this.flushUpdates(lease, setup).finally(() => {
				lease.updateTask = undefined
				if (lease.active && lease.requested) {
					void this.requestUpdate(lease, setup, lease.requested, false).catch((error) =>
						this.reportUpdateError(error),
					)
				}
			})
		}
		return initial
			? lease.updateTask
			: lease.updateTask.catch((error) => this.reportUpdateError(error))
	}

	private async flushUpdates(lease: ConsumerLease, setup: NodeModuleSetup): Promise<void> {
		while (lease.active && lease.requested) {
			const url = lease.requested
			const generation = lease.generation
			lease.requested = undefined
			const cleanup = (await setup(url)) || undefined
			if (!lease.active || generation !== lease.generation) {
				await cleanup?.()
				continue
			}
			const previous = lease.activeCleanup
			lease.activeCleanup = cleanup
			await previous?.()
		}
	}

	private async disposeLease(lease: ConsumerLease): Promise<void> {
		if (!lease.active) return
		lease.active = false
		lease.generation++
		lease.requested = undefined
		const disposeSource = lease.sourceDispose
		lease.sourceDispose = undefined
		const errors: unknown[] = []
		try {
			await disposeSource?.()
		} catch (error) {
			errors.push(error)
		}
		// Updates already report their own failures. Their late results must still drain
		// before releasing the currently active consumer, even if source detach failed.
		await lease.updateTask?.catch((): undefined => undefined)
		const cleanup = lease.activeCleanup
		lease.activeCleanup = undefined
		try {
			await cleanup?.()
		} catch (error) {
			errors.push(error)
		}
		if (errors.length === 1) throw errors[0]
		if (errors.length > 1)
			throw new AggregateError(errors, '[pluxel/runtime] Node module cleanup failed', {
				cause: errors[0],
			})
	}

	private reportUpdateError(error: unknown): void {
		this.ctx.logger.error('failed to update Node module consumer', { error })
	}
}
