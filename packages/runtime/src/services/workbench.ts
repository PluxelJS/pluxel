import type { Context } from '@pluxel/core'
import type { AnyWorkbenchExtension, WorkbenchModelContract } from '../workbench/contracts'
import type {
	WorkbenchProviders,
	WorkbenchMount,
	MountedWorkbenchCollections,
	PluginWorkbench,
} from '../workbench/runtime'
import { WorkbenchArtifactService } from './workbench/WorkbenchArtifactService'
import { WorkbenchRpcService } from './workbench/resources/WorkbenchRpcService'
import { WorkbenchCollectionService } from './workbench/resources/WorkbenchCollectionService'
import { WorkbenchEventsService } from './workbench/resources/WorkbenchEventsService'
import { WorkbenchRegistry, type InternalModelRef } from './workbench/WorkbenchRegistry'
import {
	installWorkbenchBackend,
	requireWorkbenchBackend,
	type WorkbenchBackend,
} from './workbench/WorkbenchService'

export class DefaultWorkbenchBackend implements WorkbenchBackend {
	readonly artifacts: WorkbenchArtifactService
	readonly rpc: WorkbenchRpcService
	readonly events: WorkbenchEventsService
	readonly collections: WorkbenchCollectionService
	readonly registry: WorkbenchRegistry
	private readonly views = new WeakMap<Context, PluginWorkbench>()
	private readonly mounts = new Map<string, { owner: Context; dispose: () => void }>()

	constructor(root: Context) {
		this.artifacts = new WorkbenchArtifactService(root)
		this.rpc = new WorkbenchRpcService(root, undefined)
		this.events = new WorkbenchEventsService(root, undefined)
		this.collections = new WorkbenchCollectionService(root, undefined, this.events)
		this.registry = new WorkbenchRegistry(root, this.artifacts)
		this.events.registerResourceFor(root, 'workbench.layouts', (channel) => {
			const emit = () => channel.emit('revision', this.registry.getCatalog().revision)
			emit()
			return this.registry.subscribe(emit)
		})
	}

	forContext(ctx: Context): PluginWorkbench {
		const existing = this.views.get(ctx)
		if (existing) return existing
		const view: PluginWorkbench = {
			mount: (module, bindings) => this.mount(ctx, module, bindings),
		}
		this.views.set(ctx, view)
		return view
	}

	private mount<Extension extends AnyWorkbenchExtension>(
		owner: Context,
		extension: Extension,
		providers: WorkbenchProviders<Extension>,
	): WorkbenchMount<Extension> {
		const ownerId = String(owner.pluginInfo.id ?? '').trim()
		if (extension.plugin !== ownerId) {
			throw new Error(
				`[workbench] extension plugin "${extension.plugin}" must match Context owner "${ownerId}"`,
			)
		}
		const cleanup: Array<() => void> = []
		const mountedCollections: Record<string, unknown> = {}
		const refs: Record<string, InternalModelRef> = {}
		for (const [key, contract] of Object.entries(extension.model) as Array<
			[string, WorkbenchModelContract]
		>) {
			const provider = (providers as Record<string, any>)[key]
			if (!provider || provider.kind !== contract.kind) {
				throw new Error(`[workbench] model "${key}" requires a ${contract.kind} provider`)
			}
		}

		const previous = this.mounts.get(ownerId)
		if (previous?.owner === owner) {
			throw new Error(`[workbench] plugin "${ownerId}" already mounted a Workbench extension`)
		}
		previous?.dispose()

		try {
			for (const [key, contract] of Object.entries(extension.model) as Array<
				[string, WorkbenchModelContract]
			>) {
				const provider = (providers as Record<string, any>)[key]
				refs[key] = Object.freeze({ ownerPluginId: ownerId, modelKey: key, kind: contract.kind })
				switch (contract.kind) {
					case 'rpc': {
						cleanup.push(
							this.rpc.registerResourceFor(
								owner,
								workbenchModelNamespace(ownerId, key),
								provider.factory,
							),
						)
						break
					}
					case 'events': {
						cleanup.push(
							this.events.registerResourceFor(
								owner,
								workbenchModelNamespace(ownerId, key),
								provider.handler,
							),
						)
						break
					}
					case 'collection': {
						mountedCollections[key] = this.collections.collectionFor(owner, {
							...provider.options,
							name: key,
						})
						break
					}
				}
			}

			if (extension.entry) {
				cleanup.push(this.artifacts.registerFor(owner, extension.entry))
			}
			cleanup.push(this.registry.mount(ownerId, extension, Object.freeze(refs)))
		} catch (error) {
			for (const dispose of cleanup.toReversed()) dispose()
			throw error
		}

		let active = true
		const dispose = () => {
			if (!active) return
			active = false
			for (const cleanupItem of cleanup.toReversed()) cleanupItem()
			if (this.mounts.get(ownerId)?.owner === owner) this.mounts.delete(ownerId)
		}
		const guard = owner.effects.defer(dispose)
		const mounted = { owner, dispose: () => guard.dispose() }
		this.mounts.set(ownerId, mounted)
		return Object.freeze({
			extension,
			collections: mountedCollections as MountedWorkbenchCollections<Extension>,
			dispose: mounted.dispose,
		})
	}
}

export function installWorkbench(ctx: Context): () => void {
	const backend = new DefaultWorkbenchBackend(ctx.root)
	const dispose = installWorkbenchBackend(ctx, backend)
	const guard = ctx.root.effects.defer(dispose)
	return () => guard.dispose()
}

/** @internal */
export function requireWorkbench(ctx: Context): DefaultWorkbenchBackend {
	const backend = requireWorkbenchBackend(ctx)
	if (!(backend instanceof DefaultWorkbenchBackend)) {
		throw new Error('[pluxel/runtime] Unsupported Workbench backend.')
	}
	return backend
}

export function workbenchModelNamespace(ownerPluginId: string, modelKey: string): string {
	return `${ownerPluginId}:${modelKey}`
}

export type { SseChannel } from './workbench/resources/WorkbenchEventsService'
