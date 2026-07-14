import { randomUUID } from 'node:crypto'
import type { Context, PluginIdentifier, RuntimePluginKey } from '@pluxel/core'
import type {
	WorkbenchAudience,
	WorkbenchCatalog,
	WorkbenchLayout,
	WorkbenchLayoutItem,
	WorkbenchPlacementSpec,
	WorkbenchPortContribution,
	WorkbenchPortOutlet,
	WorkbenchPortRenderer,
	WorkbenchResourceRef,
	WorkbenchViewSpec,
} from '../../workbench/contracts'
import type { AnyWorkbenchExtension } from '../../workbench/runtime'
import type { WorkbenchArtifactService } from './WorkbenchArtifactService'

type MountedExtension = {
	ownerPluginId: string
	extension: AnyWorkbenchExtension
	modelRefs: Readonly<Record<string, InternalModelRef>>
	leaseRevision: number
	disposeWatch: () => void
}

export type InternalModelRef = Readonly<{
	ownerPluginId: string
	modelKey: string
	kind: WorkbenchResourceRef['kind']
}>

type ModelGrant = InternalModelRef & { leaseRevision: number }

export class WorkbenchRegistry {
	private readonly extensions = new Map<string, MountedExtension>()
	private revision = 0
	private nextLeaseRevision = 0
	private readonly listeners = new Set<() => void>()
	private readonly grants = new Map<string, ModelGrant>()
	private readonly grantIds = new Map<string, string>()

	constructor(
		private readonly ctx: Context,
		private readonly artifacts: WorkbenchArtifactService,
	) {
		ctx.root.effects.defer(artifacts.subscribe(() => this.bump()))
	}

	mount(
		ownerPluginId: string,
		extension: AnyWorkbenchExtension,
		modelRefs: Readonly<Record<string, InternalModelRef>>,
	): () => void {
		if (this.extensions.has(ownerPluginId)) {
			throw new Error(`[workbench] plugin "${ownerPluginId}" already mounted a Workbench extension`)
		}
		const disposeWatch = this.ctx.registry.watchInstance(
			ownerPluginId as unknown as PluginIdentifier,
			() => this.bump(),
		)
		const mounted = {
			ownerPluginId,
			extension,
			modelRefs,
			leaseRevision: ++this.nextLeaseRevision,
			disposeWatch,
		}
		this.extensions.set(ownerPluginId, mounted)
		this.bump()
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.extensions.get(ownerPluginId) !== mounted) return
			this.extensions.delete(ownerPluginId)
			disposeWatch()
			this.revokeLease(mounted)
			this.bump()
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getPluginLayout(targetPluginId: string): WorkbenchLayout {
		const target = String(targetPluginId ?? '').trim()
		const items: WorkbenchLayoutItem[] = []
		for (const mounted of this.extensions.values()) {
			for (const [viewId, view] of Object.entries(mounted.extension.contract.views) as Array<
				[string, WorkbenchViewSpec]
			>) {
				for (const [placementIndex, placement] of view.placements.entries()) {
					if (!placement.placement.startsWith('plugin.')) continue
					if (!this.matchesAudience(mounted.ownerPluginId, target, placement.audience)) continue
					if (!this.available(mounted.ownerPluginId, placement)) continue
					items.push(
						this.layoutItem(
							mounted,
							viewId,
							view,
							placement,
							placementIndex,
							target,
							`plugin:${target}`,
						),
					)
				}
			}
		}
		this.resolvePorts(target, items)
		return Object.freeze({
			revision: this.revision,
			targetPluginId: target,
			items: sortItems(items),
		})
	}

	getGlobalLayout(): WorkbenchLayout {
		const items: WorkbenchLayoutItem[] = []
		for (const mounted of this.extensions.values()) {
			for (const [viewId, view] of Object.entries(mounted.extension.contract.views) as Array<
				[string, WorkbenchViewSpec]
			>) {
				for (const [placementIndex, placement] of view.placements.entries()) {
					if (!this.available(mounted.ownerPluginId, placement)) continue
					if (placement.placement === 'plugin.routes') {
						if (!placement.meta?.route?.addToNav) continue
						items.push(
							this.layoutItem(
								mounted,
								viewId,
								view,
								placement,
								placementIndex,
								mounted.ownerPluginId,
								'global-route',
								false,
							),
						)
						continue
					}
					if (!placement.placement.startsWith('global.')) continue
					items.push(
						this.layoutItem(
							mounted,
							viewId,
							view,
							placement,
							placementIndex,
							mounted.ownerPluginId,
							'global',
							true,
						),
					)
				}
			}
		}
		return Object.freeze({ revision: this.revision, targetPluginId: null, items: sortItems(items) })
	}

	getCatalog(): WorkbenchCatalog {
		const catalog = this.artifacts.getCatalog()
		return { revision: this.revision, bundles: catalog.bundles, states: catalog.states }
	}

	getArtifacts(): WorkbenchArtifactService {
		return this.artifacts
	}

	resolveModel(grantId: string, expected?: WorkbenchResourceRef['kind']): InternalModelRef {
		const model = this.findModel(grantId, expected)
		if (!model) throw new Error('[workbench] model grant is invalid or expired')
		return model
	}

	findModel(grantId: string, expected?: WorkbenchResourceRef['kind']): InternalModelRef | null {
		const grant = this.grants.get(String(grantId ?? ''))
		const mounted = grant ? this.extensions.get(grant.ownerPluginId) : undefined
		if (!grant || !mounted || mounted.leaseRevision !== grant.leaseRevision) return null
		if (expected && grant.kind !== expected) {
			throw new Error(`[workbench] model grant requires ${expected}, got ${grant.kind}`)
		}
		return Object.freeze({
			ownerPluginId: grant.ownerPluginId,
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
		targetPluginId: string,
		scope: string,
		includeModel = true,
	): WorkbenchLayoutItem {
		const viewKey = `${mounted.ownerPluginId}:${viewId}`
		const id = `${viewKey}:${placementIndex}`
		return Object.freeze({
			id,
			viewId,
			ownerPluginId: mounted.ownerPluginId,
			targetPluginId,
			contractFingerprint: mounted.extension.contract.fingerprint,
			placement: placement.placement,
			view: view.view ?? Object.freeze({ kind: 'remote', export: viewId }),
			priority: placement.priority ?? 0,
			when: placement.when ?? 'running',
			meta: placement.meta,
			model: includeModel
				? this.grantModel(`${scope}:${viewKey}`, mounted.modelRefs)
				: Object.freeze({}),
		})
	}

	private resolvePorts(targetPluginId: string, items: WorkbenchLayoutItem[]): void {
		const target = this.extensions.get(targetPluginId)
		if (!target) return
		const outlets = (
			target.extension.contract.ports as readonly WorkbenchPortContribution[]
		).filter((item): item is WorkbenchPortOutlet => item.kind === 'port')
		for (const outlet of outlets) {
			const candidates: Array<{ mounted: MountedExtension; renderer: WorkbenchPortRenderer }> = []
			for (const mounted of this.extensions.values()) {
				if (!this.isRequiredDependent(mounted.ownerPluginId, targetPluginId)) continue
				if (!this.isRunning(mounted.ownerPluginId)) continue
				for (const item of mounted.extension.contract.ports) {
					if (item.kind !== 'port-renderer' || !samePort(outlet, item)) continue
					candidates.push({ mounted, renderer: item })
				}
			}
			candidates.sort((a, b) => a.mounted.ownerPluginId.localeCompare(b.mounted.ownerPluginId))
			if (candidates.length > 1) {
				items.push(
					this.portStatusItem(
						targetPluginId,
						outlet,
						'Workbench renderer is ambiguous',
						`Port ${outlet.port.id} v${outlet.port.version} has multiple providers: ${candidates
							.map(({ mounted }) => mounted.ownerPluginId)
							.join(', ')}`,
					),
				)
				continue
			}
			const selected = candidates[0]
			if (!selected) {
				items.push(
					this.portStatusItem(
						targetPluginId,
						outlet,
						'Workbench renderer unavailable',
						`No running direct dependency provides Port ${outlet.port.id} v${outlet.port.version}.`,
					),
				)
				continue
			}
			const when = outlet.when ?? 'running'
			if (when === 'running' && !this.isRunning(selected.mounted.ownerPluginId)) continue
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
			const id = `${targetPluginId}:${outlet.id}<-${selected.mounted.ownerPluginId}:${selected.renderer.id}`
			items.push(
				Object.freeze({
					id,
					viewId: selected.renderer.viewId,
					ownerPluginId: selected.mounted.ownerPluginId,
					targetPluginId,
					contractFingerprint: selected.mounted.extension.contract.fingerprint,
					placement: outlet.placement,
					view: Object.freeze({ kind: 'remote', export: selected.renderer.viewId }),
					priority: outlet.priority ?? 0,
					when,
					meta: outlet.meta,
					model: this.grantModel(
						`plugin:${targetPluginId}:${id}:owner`,
						selected.mounted.modelRefs,
					),
					port: Object.freeze({
						id: outlet.port.id,
						version: outlet.port.version,
						model: this.grantModel(`plugin:${targetPluginId}:${id}:port`, portRefs),
					}),
				}),
			)
		}
	}

	private portStatusItem(
		targetPluginId: string,
		outlet: WorkbenchPortOutlet,
		title: string,
		description: string,
	): WorkbenchLayoutItem {
		return Object.freeze({
			id: `${targetPluginId}:${outlet.id}:status`,
			viewId: `${outlet.id}:status`,
			ownerPluginId: targetPluginId,
			targetPluginId,
			contractFingerprint: this.extensions.get(targetPluginId)?.extension.contract.fingerprint ?? '',
			placement: outlet.placement,
			view: Object.freeze({
				kind: 'builtin',
				renderer: 'document',
				props: Object.freeze({ title, description, content: Object.freeze([]) }),
			}),
			priority: outlet.priority ?? 0,
			when: outlet.when ?? 'running',
			meta: outlet.meta,
			model: Object.freeze({}),
		})
	}

	private available(ownerPluginId: string, placement: WorkbenchPlacementSpec): boolean {
		return (placement.when ?? 'running') === 'always' || this.isRunning(ownerPluginId)
	}

	private matchesAudience(owner: string, target: string, audience: WorkbenchAudience): boolean {
		return audience.kind === 'self' ? owner === target : this.isRequiredDependent(owner, target)
	}

	private isRequiredDependent(provider: string, consumer: string): boolean {
		const providerKey = this.ctx.registry.resolveRuntimeKey(provider as RuntimePluginKey)
		const consumerKey = this.ctx.registry.resolveRuntimeKey(consumer as RuntimePluginKey)
		if (!providerKey || !consumerKey) return false
		return this.ctx.registry.graph.depsOf(consumerKey).includes(providerKey as RuntimePluginKey)
	}

	private isRunning(ownerPluginId: string): boolean {
		return this.ctx.registry.isRunning(ownerPluginId as unknown as PluginIdentifier)
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
			const owner = this.extensions.get(ref.ownerPluginId)
			if (!owner) continue
			const grantKey = `${owner.leaseRevision}:${scope}:${key}:${ref.ownerPluginId}:${ref.modelKey}:${ref.kind}`
			let grantId = this.grantIds.get(grantKey)
			if (!grantId) {
				grantId = randomUUID()
				this.grantIds.set(grantKey, grantId)
				this.grants.set(grantId, { ...ref, leaseRevision: owner.leaseRevision })
			}
			result[key] = Object.freeze({ grantId, kind: ref.kind })
		}
		return Object.freeze(result)
	}

	private revokeLease(mounted: MountedExtension): void {
		for (const [grantId, grant] of this.grants) {
			if (
				grant.ownerPluginId === mounted.ownerPluginId &&
				grant.leaseRevision === mounted.leaseRevision
			) {
				this.grants.delete(grantId)
			}
		}
		for (const [key, grantId] of this.grantIds) {
			if (!this.grants.has(grantId)) this.grantIds.delete(key)
		}
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
