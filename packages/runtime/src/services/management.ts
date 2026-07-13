import type { Context } from '@pluxel/core'
import type { AnyManagementModule, ManagementResourceContract } from '../management/contracts'
import type {
	ManagementBindings,
	ManagementMount,
	MountedManagementResources,
	PluginManagement,
} from '../management/runtime'
import { ManagementArtifactService } from './management/ManagementArtifactService'
import { ManagementApiService } from './management/resources/ManagementApiService'
import { ManagementCollectionService } from './management/resources/ManagementCollectionService'
import { ManagementStreamService } from './management/resources/ManagementStreamService'
import { ManagementRegistry, type InternalResourceRef } from './management/ManagementRegistry'
import {
	installManagementBackend,
	requireManagementBackend,
	type ManagementBackend,
} from './management/ManagementService'

export class DefaultManagementBackend implements ManagementBackend {
	readonly artifacts: ManagementArtifactService
	readonly api: ManagementApiService
	readonly streams: ManagementStreamService
	readonly collections: ManagementCollectionService
	readonly registry: ManagementRegistry
	private readonly views = new WeakMap<Context, PluginManagement>()

	constructor(root: Context) {
		this.artifacts = new ManagementArtifactService(root)
		this.api = new ManagementApiService(root, undefined)
		this.streams = new ManagementStreamService(root, undefined)
		this.collections = new ManagementCollectionService(root, undefined, this.streams)
		this.registry = new ManagementRegistry(root, this.artifacts)
		this.streams.registerResourceFor(root, 'management.layouts', (channel) => {
			const emit = () => channel.emit('revision', this.registry.getCatalog().revision)
			emit()
			return this.registry.subscribe(emit)
		})
	}

	forContext(ctx: Context): PluginManagement {
		const existing = this.views.get(ctx)
		if (existing) return existing
		const view: PluginManagement = {
			mount: (module, bindings) => this.mount(ctx, module, bindings),
		}
		this.views.set(ctx, view)
		return view
	}

	private mount<Module extends AnyManagementModule>(
		owner: Context,
		module: Module,
		bindings: ManagementBindings<Module>,
	): ManagementMount<Module> {
		const ownerId = String(owner.pluginInfo.id ?? '').trim()
		const cleanup: Array<() => void> = []
		const mountedResources: Record<string, unknown> = {}
		const refs: Record<string, InternalResourceRef> = {}

		try {
			for (const [key, contract] of Object.entries(module.resources) as Array<
				[string, ManagementResourceContract]
			>) {
				const binding = (bindings as Record<string, any>)[key]
				if (!binding || binding.kind !== contract.kind) {
					throw new Error(`[management] resource "${key}" requires a ${contract.kind} binding`)
				}
				refs[key] = Object.freeze({ owner: ownerId, resource: key, kind: contract.kind })
				switch (contract.kind) {
					case 'api': {
						cleanup.push(
							this.api.registerResourceFor(
								owner,
								managementResourceNamespace(ownerId, key),
								binding.factory,
							),
						)
						mountedResources[key] = undefined
						break
					}
					case 'stream': {
						cleanup.push(
							this.streams.registerResourceFor(
								owner,
								managementResourceNamespace(ownerId, key),
								binding.handler,
							),
						)
						mountedResources[key] = undefined
						break
					}
					case 'collection': {
						mountedResources[key] = this.collections.collectionFor(owner, {
							...binding.options,
							name: key,
						})
						break
					}
				}
			}

			if (module.ui) {
				cleanup.push(this.artifacts.registerFor(owner, module.ui))
			}
			cleanup.push(this.registry.mount(ownerId, module, Object.freeze(refs)))
		} catch (error) {
			for (const dispose of cleanup.toReversed()) dispose()
			throw error
		}

		let active = true
		const dispose = () => {
			if (!active) return
			active = false
			for (const cleanupItem of cleanup.toReversed()) cleanupItem()
		}
		const guard = owner.effects.defer(dispose)
		return Object.freeze({
			module,
			resources: mountedResources as MountedManagementResources<Module>,
			dispose: () => guard.dispose(),
		})
	}
}

export function installManagement(ctx: Context): () => void {
	const backend = new DefaultManagementBackend(ctx.root)
	const dispose = installManagementBackend(ctx, backend)
	const guard = ctx.root.effects.defer(dispose)
	return () => guard.dispose()
}

/** @internal */
export function requireManagement(ctx: Context): DefaultManagementBackend {
	const backend = requireManagementBackend(ctx)
	if (!(backend instanceof DefaultManagementBackend)) {
		throw new Error('[pluxel/runtime] Unsupported Management backend.')
	}
	return backend
}

export function managementResourceNamespace(owner: string, resource: string): string {
	return `${owner}:${resource}`
}

export type { SseChannel } from './management/resources/ManagementStreamService'
