import type { Context } from '@pluxel/core'
import type { WorkbenchResourceContract } from '../workbench/contracts'
import type {
	AnyWorkbenchExtension,
	WorkbenchBindings,
	WorkbenchMount,
	PluginWorkbench,
} from '../workbench/runtime'
import { WorkbenchArtifactService } from './workbench/WorkbenchArtifactService'
import { WorkbenchRpcService } from './workbench/resources/WorkbenchRpcService'
import { WorkbenchEventsService } from './workbench/resources/WorkbenchEventsService'
import { WorkbenchLiveQueryService } from './workbench/resources/WorkbenchLiveQueryService'
import { WorkbenchRegistry, type InternalModelRef } from './workbench/WorkbenchRegistry'
import { installWorkbenchForRoot, requireInstalledWorkbench } from './workbench/WorkbenchService'

export class WorkbenchBackend {
	readonly artifacts: WorkbenchArtifactService
	readonly rpc: WorkbenchRpcService
	readonly events: WorkbenchEventsService
	readonly liveQueries: WorkbenchLiveQueryService
	readonly registry: WorkbenchRegistry
	private readonly views = new WeakMap<Context, PluginWorkbench>()
	private readonly mounts = new Map<string, { owner: Context; dispose: () => void }>()

	constructor(root: Context) {
		this.artifacts = new WorkbenchArtifactService(root)
		this.rpc = new WorkbenchRpcService(root, undefined)
		this.events = new WorkbenchEventsService(root, undefined)
		this.liveQueries = new WorkbenchLiveQueryService(root, this.events)
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

	private mount<
		Extension extends AnyWorkbenchExtension,
		const Bindings extends WorkbenchBindings<Extension>,
	>(owner: Context, extension: Extension, bindings: Bindings): WorkbenchMount<Extension, Bindings> {
		const ownerId = String(owner.pluginInfo.id ?? '').trim()
		const cleanup: Array<() => void> = []
		const refs: Record<string, InternalModelRef> = {}
		const resources = extension.contract.resources
		const expectedKeys = Object.keys(resources).sort()
		const actualKeys = Object.keys(bindings as object).sort()
		if (expectedKeys.join('\0') !== actualKeys.join('\0')) {
			const missing = expectedKeys.filter((key) => !actualKeys.includes(key))
			const extra = actualKeys.filter((key) => !expectedKeys.includes(key))
			throw new Error(
				`[workbench] bindings must exactly match Contract resources` +
					`${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
					`${extra.length > 0 ? `; extra: ${extra.join(', ')}` : ''}`,
			)
		}
		for (const [key, contract] of Object.entries(resources) as Array<
			[string, WorkbenchResourceContract]
		>) {
			const binding = (bindings as Record<string, any>)[key]
			if (!binding || binding.kind !== contract.kind) {
				throw new Error(`[workbench] bindings.${key}: expected ${contract.kind} binding`)
			}
		}

		const previous = this.mounts.get(ownerId)
		if (previous?.owner === owner) {
			throw new Error(`[workbench] plugin "${ownerId}" already mounted a Workbench extension`)
		}
		previous?.dispose()

		try {
			for (const [key, contract] of Object.entries(resources) as Array<
				[string, WorkbenchResourceContract]
			>) {
				const binding = (bindings as Record<string, any>)[key]
				refs[key] = Object.freeze({ ownerPluginId: ownerId, modelKey: key, kind: contract.kind })
				switch (contract.kind) {
					case 'rpc': {
						cleanup.push(
							this.rpc.registerResourceFor(
								owner,
								workbenchModelNamespace(ownerId, key),
								binding.factory,
							),
						)
						break
					}
					case 'events': {
						cleanup.push(
							this.events.registerResourceFor(
								owner,
								workbenchModelNamespace(ownerId, key),
								binding.handler,
							),
						)
						break
					}
					case 'liveQuery': {
						cleanup.push(this.liveQueries.registerResourceFor(owner, key, contract, binding))
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
		})
	}
}

export function installWorkbench(ctx: Context): () => void {
	const backend = new WorkbenchBackend(ctx.root)
	const dispose = installWorkbenchForRoot(ctx, backend)
	const guard = ctx.root.effects.defer(dispose)
	return () => guard.dispose()
}

/** @internal */
export function requireWorkbench(ctx: Context): WorkbenchBackend {
	return requireInstalledWorkbench(ctx)
}

export function workbenchModelNamespace(ownerPluginId: string, modelKey: string): string {
	return `${ownerPluginId}:${modelKey}`
}

export type { SseChannel } from './workbench/resources/WorkbenchEventsService'
