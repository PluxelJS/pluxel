import { randomUUID } from 'node:crypto'
import {
	getPluginInfo,
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type Context,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from '@pluxel/core'
import type {
	WorkbenchCatalog,
	WorkbenchLayout,
	WorkbenchLayoutItem,
	WorkbenchPlacementSpec,
	WorkbenchPluginDescriptor,
	WorkbenchPortContribution,
	WorkbenchPortOutlet,
	WorkbenchPortRenderer,
	WorkbenchResourceRef,
	WorkbenchViewSpec,
} from '../../workbench/contracts'
import type { AnyWorkbenchExtension } from '../../workbench/runtime'
import type { WorkbenchArtifactService } from './WorkbenchArtifactService'

type MountedExtension = {
	ownerSlot: PluginNodeSlot
	owner: WorkbenchPluginDescriptor
	extension: AnyWorkbenchExtension
	modelRefs: Readonly<Record<string, InternalModelRef>>
	leaseRevision: number
	disposeWatch: () => void
}

export type InternalModelRef = Readonly<{
	ownerSlot: PluginNodeSlot
	/** Opaque server-only resource namespace. It is never derived from a Plugin name/address. */
	resourceId: string
	modelKey: string
	kind: WorkbenchResourceRef['kind']
}>

type ModelGrant = InternalModelRef & { leaseRevision: number }

export class WorkbenchRegistry {
	private readonly extensions = new Map<PluginNodeSlot, MountedExtension>()
	private revision = 0
	private nextLeaseRevision = 0
	private readonly listeners = new Set<() => void>()
	private readonly grants = new Map<string, ModelGrant>()
	private readonly grantIds = new WeakMap<MountedExtension, Map<string, string>>()

	constructor(
		private readonly ctx: Context,
		private readonly artifacts: WorkbenchArtifactService,
	) {
		ctx.root.effects.defer(artifacts.subscribe(() => this.bump()))
	}

	mount(
		ownerSlot: PluginNodeSlot,
		owner: WorkbenchPluginDescriptor,
		extension: AnyWorkbenchExtension,
		modelRefs: Readonly<Record<string, InternalModelRef>>,
	): () => void {
		if (this.extensions.has(ownerSlot)) {
			throw new Error(
				`[workbench] Plugin node already mounted a Workbench extension: ${pluginNodeIndexKey(owner.address)}`,
			)
		}
		const disposeWatch = this.ctx.registry.watchInstance(ownerSlot, () => this.bump())
		const mounted: MountedExtension = {
			ownerSlot,
			owner,
			extension,
			modelRefs,
			leaseRevision: ++this.nextLeaseRevision,
			disposeWatch,
		}
		this.extensions.set(ownerSlot, mounted)
		this.bump()
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.extensions.get(ownerSlot) !== mounted) return
			this.extensions.delete(ownerSlot)
			disposeWatch()
			this.revokeLease(mounted)
			this.bump()
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getPluginLayout(targetAddress: PluginNodeAddress): WorkbenchLayout {
		const targetSlot = this.ctx.registry.internNodeAddress(targetAddress)
		const target = this.describeNode(targetSlot)
		const items: WorkbenchLayoutItem[] = []
		const mounted = this.extensions.get(targetSlot)
		if (mounted && this.isRunning(mounted.ownerSlot)) {
			for (const [viewId, view] of Object.entries(mounted.extension.contract.views) as Array<
				[string, WorkbenchViewSpec]
			>) {
				for (const [placementIndex, placement] of view.placements.entries()) {
					items.push(
						this.layoutItem(
							mounted,
							viewId,
							view,
							placement,
							placementIndex,
							target,
							`plugin:${pluginNodeIndexKey(target.address)}`,
						),
					)
				}
			}
		}
		this.resolvePorts(targetSlot, target, items)
		return Object.freeze({
			revision: this.revision,
			target,
			items: sortItems(items),
		})
	}

	getGlobalLayout(): WorkbenchLayout {
		const items: WorkbenchLayoutItem[] = []
		for (const mounted of this.extensions.values()) {
			if (!this.isRunning(mounted.ownerSlot)) continue
			for (const [viewId, view] of Object.entries(mounted.extension.contract.views) as Array<
				[string, WorkbenchViewSpec]
			>) {
				for (const [placementIndex, placement] of view.placements.entries()) {
					if (placement.placement !== 'plugin.routes' || !placement.meta?.route?.addToNav) {
						continue
					}
					items.push(
						this.layoutItem(
							mounted,
							viewId,
							view,
							placement,
							placementIndex,
							mounted.owner,
							'global-route',
							false,
						),
					)
				}
			}
		}
		return Object.freeze({ revision: this.revision, target: null, items: sortItems(items) })
	}

	getCatalog(): WorkbenchCatalog {
		const catalog = this.artifacts.getCatalog()
		return { revision: this.revision, bundles: catalog.bundles, states: catalog.states }
	}

	resolveModel(grantId: string, expected?: WorkbenchResourceRef['kind']): InternalModelRef {
		const model = this.findModel(grantId, expected)
		if (!model) throw new Error('[workbench] model grant is invalid or expired')
		return model
	}

	findModel(grantId: string, expected?: WorkbenchResourceRef['kind']): InternalModelRef | null {
		const grant = this.grants.get(String(grantId ?? ''))
		const mounted = grant ? this.extensions.get(grant.ownerSlot) : undefined
		if (!grant || !mounted || mounted.leaseRevision !== grant.leaseRevision) return null
		if (expected && grant.kind !== expected) {
			throw new Error(`[workbench] model grant requires ${expected}, got ${grant.kind}`)
		}
		return Object.freeze({
			ownerSlot: grant.ownerSlot,
			resourceId: grant.resourceId,
			modelKey: grant.modelKey,
			kind: grant.kind,
		})
	}

	private layoutItem(
		mounted: MountedExtension,
		viewId: string,
		view: WorkbenchViewSpec,
		placement: WorkbenchPlacementSpec,
		placementIndex: number,
		target: WorkbenchPluginDescriptor,
		scope: string,
		includeModel = true,
	): WorkbenchLayoutItem {
		const viewKey = `${pluginNodeIndexKey(mounted.owner.address)}:${viewId}`
		const id = `${viewKey}:${placementIndex}`
		return Object.freeze({
			id,
			viewId,
			owner: mounted.owner,
			target,
			contractFingerprint: mounted.extension.contract.fingerprint,
			placement: placement.placement,
			view: view.view ?? Object.freeze({ kind: 'remote', export: viewId }),
			priority: placement.priority ?? 0,
			meta: placement.meta,
			model: includeModel
				? this.grantModel(`${scope}:${viewKey}`, mounted.modelRefs)
				: Object.freeze({}),
		})
	}

	private resolvePorts(
		targetSlot: PluginNodeSlot,
		targetDescriptor: WorkbenchPluginDescriptor,
		items: WorkbenchLayoutItem[],
	): void {
		const target = this.extensions.get(targetSlot)
		if (!target) return
		const outlets = (
			target.extension.contract.ports as readonly WorkbenchPortContribution[]
		).filter((item): item is WorkbenchPortOutlet => item.kind === 'port')
		for (const outlet of outlets) {
			const candidates: Array<{ mounted: MountedExtension; renderer: WorkbenchPortRenderer }> = []
			for (const mounted of this.extensions.values()) {
				if (!this.isRequiredDependent(mounted.ownerSlot, targetSlot)) continue
				if (!this.isRunning(mounted.ownerSlot)) continue
				for (const item of mounted.extension.contract.ports) {
					if (item.kind !== 'port-renderer' || !samePort(outlet, item)) continue
					candidates.push({ mounted, renderer: item })
				}
			}
			candidates.sort((a, b) =>
				pluginNodeIndexKey(a.mounted.owner.address).localeCompare(
					pluginNodeIndexKey(b.mounted.owner.address),
				),
			)
			if (candidates.length > 1) {
				items.push(
					this.portStatusItem(
						targetDescriptor,
						outlet,
						'Workbench renderer is ambiguous',
						`Port ${outlet.port.id} v${outlet.port.version} has multiple providers: ${candidates
							.map(({ mounted }) => mounted.owner.displayName)
							.join(', ')}`,
					),
				)
				continue
			}
			const selected = candidates[0]
			if (!selected) {
				items.push(
					this.portStatusItem(
						targetDescriptor,
						outlet,
						'Workbench renderer unavailable',
						`No running direct dependency provides Port ${outlet.port.id} v${outlet.port.version}.`,
					),
				)
				continue
			}
			const view = selected.mounted.extension.contract.views[selected.renderer.viewId]
			if (!view) {
				throw new Error(
					`[workbench] port renderer "${selected.renderer.id}" references an unknown view`,
				)
			}
			const portRefs: Record<string, InternalModelRef> = {}
			for (const [portKey, targetKey] of Object.entries(outlet.provide) as Array<
				[string, string]
			>) {
				const ref = target.modelRefs[targetKey]
				const expected = outlet.port.resources[portKey]
				if (!ref || !expected || ref.kind !== expected.kind) {
					throw new Error(`[workbench] port "${outlet.id}" has invalid model mapping "${portKey}"`)
				}
				portRefs[portKey] = ref
			}
			const targetKey = pluginNodeIndexKey(targetDescriptor.address)
			const ownerKey = pluginNodeIndexKey(selected.mounted.owner.address)
			const id = `${targetKey}:${outlet.id}<-${ownerKey}:${selected.renderer.id}`
			items.push(
				Object.freeze({
					id,
					viewId: selected.renderer.viewId,
					owner: selected.mounted.owner,
					target: targetDescriptor,
					contractFingerprint: selected.mounted.extension.contract.fingerprint,
					placement: outlet.placement,
					view: Object.freeze({ kind: 'remote', export: selected.renderer.viewId }),
					priority: outlet.priority ?? 0,
					meta: outlet.meta,
					model: this.grantModel(`plugin:${targetKey}:${id}:owner`, selected.mounted.modelRefs),
					port: Object.freeze({
						id: outlet.port.id,
						version: outlet.port.version,
						model: this.grantModel(`plugin:${targetKey}:${id}:port`, portRefs),
					}),
				}),
			)
		}
	}

	private portStatusItem(
		target: WorkbenchPluginDescriptor,
		outlet: WorkbenchPortOutlet,
		title: string,
		description: string,
	): WorkbenchLayoutItem {
		const targetSlot = this.ctx.registry.internNodeAddress(target.address)
		const targetKey = pluginNodeIndexKey(target.address)
		return Object.freeze({
			id: `${targetKey}:${outlet.id}:status`,
			viewId: `${outlet.id}:status`,
			owner: target,
			target,
			contractFingerprint: this.extensions.get(targetSlot)?.extension.contract.fingerprint ?? '',
			placement: outlet.placement,
			view: Object.freeze({
				kind: 'builtin',
				renderer: 'document',
				props: Object.freeze({ title, description, content: Object.freeze([]) }),
			}),
			priority: outlet.priority ?? 0,
			meta: outlet.meta,
			model: Object.freeze({}),
		})
	}

	private isRequiredDependent(provider: PluginNodeSlot, consumer: PluginNodeSlot): boolean {
		return this.ctx.registry.graph.depsOf(consumer).includes(provider)
	}

	private isRunning(owner: PluginNodeSlot): boolean {
		return this.ctx.registry.isRunning(owner)
	}

	private describeNode(slot: PluginNodeSlot): WorkbenchPluginDescriptor {
		const mounted = this.extensions.get(slot)
		if (mounted) return mounted.owner
		const address = parsePluginNodeAddress(this.ctx.registry.nodeAddressOf(slot))
		const ctor = this.ctx.runtimeRoute?.catalog.resolve(address)
		const info = ctor ? getPluginInfo(ctor) : undefined
		return Object.freeze({
			address,
			displayName: info?.displayName ?? address.definition.exportName,
			rootExportName: info?.rootExportName ?? address.definition.exportName,
		})
	}

	private bump(): void {
		this.revision += 1
		for (const listener of this.listeners) listener()
	}

	private grantModel(
		scope: string,
		refs: Readonly<Record<string, InternalModelRef>>,
	): Readonly<Record<string, WorkbenchResourceRef>> {
		const result: Record<string, WorkbenchResourceRef> = {}
		for (const [key, ref] of Object.entries(refs)) {
			const owner = this.extensions.get(ref.ownerSlot)
			if (!owner) continue
			let byKey = this.grantIds.get(owner)
			if (!byKey) {
				byKey = new Map()
				this.grantIds.set(owner, byKey)
			}
			const grantKey = `${scope}\0${key}\0${ref.resourceId}\0${ref.kind}`
			let grantId = byKey.get(grantKey)
			if (!grantId) {
				grantId = randomUUID()
				byKey.set(grantKey, grantId)
				this.grants.set(grantId, { ...ref, leaseRevision: owner.leaseRevision })
			}
			result[key] = Object.freeze({ grantId, kind: ref.kind })
		}
		return Object.freeze(result)
	}

	private revokeLease(mounted: MountedExtension): void {
		for (const [grantId, grant] of this.grants) {
			if (grant.ownerSlot === mounted.ownerSlot && grant.leaseRevision === mounted.leaseRevision) {
				this.grants.delete(grantId)
			}
		}
		this.grantIds.delete(mounted)
	}
}

function samePort(outlet: WorkbenchPortOutlet, renderer: WorkbenchPortRenderer): boolean {
	return outlet.port.id === renderer.port.id && outlet.port.version === renderer.port.version
}

function sortItems(items: WorkbenchLayoutItem[]): readonly WorkbenchLayoutItem[] {
	items.sort(
		(a, b) =>
			String(a.placement).localeCompare(String(b.placement)) ||
			b.priority - a.priority ||
			a.id.localeCompare(b.id),
	)
	return Object.freeze(items)
}
