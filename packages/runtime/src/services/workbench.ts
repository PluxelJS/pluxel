import { randomUUID } from 'node:crypto'
import type { Context, PluginNodeSlot } from '@pluxel/core'
import {
	readProductDescriptor,
	type HostApplicationMeta,
	type ProductDescriptor,
} from '../product-contract'
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
import { WorkbenchPluginCatalogService } from './workbench/WorkbenchPluginCatalogService'
import { installWorkbenchForRoot, requireInstalledWorkbench } from './workbench/WorkbenchService'

export class WorkbenchBackend {
	readonly application: HostApplicationMeta
	readonly artifacts: WorkbenchArtifactService
	readonly rpc: WorkbenchRpcService
	readonly events: WorkbenchEventsService
	readonly liveQueries: WorkbenchLiveQueryService
	readonly registry: WorkbenchRegistry
	readonly pluginCatalog: WorkbenchPluginCatalogService
	private readonly views = new WeakMap<Context, PluginWorkbench>()
	private readonly mounts = new Map<PluginNodeSlot, { owner: Context; dispose: () => void }>()

	constructor(root: Context, options: WorkbenchInstallOptions = {}) {
		this.application = Object.freeze({
			product:
				options.product === undefined || options.product === null
					? null
					: readProductDescriptor(options.product, '[workbench] product'),
		})
		this.artifacts = new WorkbenchArtifactService(root)
		this.rpc = new WorkbenchRpcService(root, undefined)
		this.events = new WorkbenchEventsService(root, undefined)
		this.liveQueries = new WorkbenchLiveQueryService(this.events)
		this.registry = new WorkbenchRegistry(root, this.artifacts)
		this.pluginCatalog = new WorkbenchPluginCatalogService(root)
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
		const ownerSlot = owner.pluginInfo.nodeSlot
		const ownerDescriptor = Object.freeze({
			address: owner.pluginInfo.nodeAddress,
			displayName: owner.pluginInfo.displayName,
			rootExportName: owner.pluginInfo.definitionAddress.exportName,
		})
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

		const previous = this.mounts.get(ownerSlot)
		if (previous?.owner === owner) {
			throw new Error(`[workbench] Plugin node already mounted a Workbench extension`)
		}
		previous?.dispose()

		try {
			for (const [key, contract] of Object.entries(resources) as Array<
				[string, WorkbenchResourceContract]
			>) {
				const binding = (bindings as Record<string, any>)[key]
				const resourceId = randomUUID()
				refs[key] = Object.freeze({ ownerSlot, resourceId, modelKey: key, kind: contract.kind })
				switch (contract.kind) {
					case 'rpc': {
						cleanup.push(this.rpc.registerResourceFor(owner, resourceId, binding.factory))
						break
					}
					case 'events': {
						cleanup.push(this.events.registerResourceFor(owner, resourceId, binding.handler))
						break
					}
					case 'liveQuery': {
						cleanup.push(
							this.liveQueries.registerResourceFor(owner, resourceId, key, contract, binding),
						)
						break
					}
				}
			}

			if (extension.entry) {
				cleanup.push(
					this.artifacts.registerFor(owner, extension.entry, extension.contract.fingerprint),
				)
			}
			cleanup.push(this.registry.mount(ownerSlot, ownerDescriptor, extension, Object.freeze(refs)))
		} catch (error) {
			for (const dispose of cleanup.toReversed()) dispose()
			throw error
		}

		let active = true
		const dispose = () => {
			if (!active) return
			active = false
			for (const cleanupItem of cleanup.toReversed()) cleanupItem()
			if (this.mounts.get(ownerSlot)?.owner === owner) this.mounts.delete(ownerSlot)
		}
		const guard = owner.effects.defer(dispose)
		const mounted = { owner, dispose: () => guard.dispose() }
		this.mounts.set(ownerSlot, mounted)
		return Object.freeze({
			extension,
		})
	}
}

export type WorkbenchInstallOptions = Readonly<{
	product?: ProductDescriptor | null
}>

export function installWorkbench(ctx: Context, options: WorkbenchInstallOptions = {}): () => void {
	const backend = new WorkbenchBackend(ctx.root, options)
	const dispose = installWorkbenchForRoot(ctx, backend)
	const guard = ctx.root.effects.defer(dispose)
	return () => guard.dispose()
}

/** @internal */
export function requireWorkbench(ctx: Context): WorkbenchBackend {
	return requireInstalledWorkbench(ctx)
}

export type { SseChannel } from './workbench/resources/WorkbenchEventsService'
