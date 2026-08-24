import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { Context as CoreContext } from '@pluxel/core'
import { pinOwnerContext } from '../context/owner-view'
import {
	readNodeModuleDeclaration,
	type NodeModuleCleanup,
	type NodeModuleDeclaration,
	type NodeModuleSetup,
} from './node-module'

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
	readonly artifacts: NodeModuleArtifactHostOptions
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

const rootStates = new WeakMap<NodeModuleService, RootState>()

export class NodeModuleService {
	constructor(
		public readonly ctx: CoreContext,
		options?: NodeModuleArtifactHostOptions,
	) {
		pinOwnerContext(this, ctx)
		if (ctx === ctx.root) {
			rootStates.set(this, { artifacts: options ?? Object.freeze({}) })
		}
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
			if (binder) {
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
			await guard.disposeAsync()
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

	private rootState(): RootState {
		const rootService = this.ctx.root.nodeModules as NodeModuleService
		const state = rootStates.get(rootService)
		if (!state) throw new Error('[pluxel/runtime] Node module root capability is unavailable')
		return state
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
		const file = configuredRoot
			? `${configuredRoot.replace(/[\\/]$/, '')}/${descriptor.artifactKey}.mjs`
			: await artifacts.resolve?.(root, this.ctx.pluginInfo.nodeAddress, descriptor.artifactKey)
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
		await disposeSource?.()
		await lease.updateTask?.catch((): undefined => undefined)
		const cleanup = lease.activeCleanup
		lease.activeCleanup = undefined
		await cleanup?.()
	}

	private reportUpdateError(error: unknown): void {
		this.ctx.logger.error('failed to update Node module consumer', { error })
	}
}
