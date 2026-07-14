import { randomUUID } from 'node:crypto'
import type { Context, PluginIdentifier, RuntimePluginKey } from '@pluxel/core'
import type {
	AnyManagementModule,
	ManagementAudience,
	ManagementCatalog,
	ManagementLayout,
	ManagementLayoutItem,
	ManagementPortContribution,
	ManagementPortRendererContribution,
	ManagementResourceRef,
} from '../../management/contracts'
import type { ManagementArtifactService } from './ManagementArtifactService'

type MountedModule = {
	owner: string
	module: AnyManagementModule
	resourceRefs: Readonly<Record<string, InternalResourceRef>>
	disposeWatch: () => void
}

export type InternalResourceRef = Readonly<{
	owner: string
	resource: string
	kind: ManagementResourceRef['kind']
}>

type ResourceGrant = InternalResourceRef & { revision: number }

export class ManagementRegistry {
	private readonly modules = new Map<string, MountedModule>()
	private revision = 0
	private grantRevision = 0
	private readonly listeners = new Set<() => void>()
	private readonly grants = new Map<string, ResourceGrant>()
	private readonly grantKeys = new Map<string, string>()

	constructor(
		private readonly ctx: Context,
		private readonly artifacts: ManagementArtifactService,
	) {
		const disposeArtifacts = artifacts.subscribe(() => this.bump(false))
		ctx.root.effects.defer(disposeArtifacts)
	}

	mount(
		owner: string,
		module: AnyManagementModule,
		resourceRefs: Readonly<Record<string, InternalResourceRef>>,
	): () => void {
		if (module.id !== owner) {
			throw new Error(`[management] module id "${module.id}" must match owner plugin "${owner}"`)
		}
		if (this.modules.has(owner)) {
			throw new Error(`[management] plugin "${owner}" already mounted a management module`)
		}

		const disposeWatch = this.ctx.registry.watchInstance(owner as unknown as PluginIdentifier, () =>
			this.bump(),
		)
		const mounted = { owner, module, resourceRefs, disposeWatch }
		this.modules.set(owner, mounted)
		this.bump()
		let active = true
		return () => {
			if (!active) return
			active = false
			if (this.modules.get(owner) !== mounted) return
			this.modules.delete(owner)
			mounted.disposeWatch()
			this.bump()
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getPluginLayout(target: string): ManagementLayout {
		const normalized = String(target ?? '').trim()
		const items: ManagementLayoutItem[] = []
		for (const mounted of this.modules.values()) {
			for (const contribution of mounted.module.contributions) {
				if (contribution.kind === 'view') {
					if (!String(contribution.placement).startsWith('plugin.')) continue
					if (!this.matchesAudience(mounted.owner, normalized, contribution.audience)) continue
					if ((contribution.requireRunning ?? true) && !this.isRunning(mounted.owner)) continue
					const itemId = `${mounted.owner}:${contribution.id}`
					items.push({
						id: itemId,
						owner: mounted.owner,
						target: normalized,
						placement: contribution.placement,
						view: contribution.view,
						priority: contribution.priority ?? 0,
						requireRunning: contribution.requireRunning ?? true,
						meta: contribution.meta,
						resources: this.grantResources(`plugin:${normalized}:${itemId}`, mounted.resourceRefs),
					})
				}
			}
		}
		this.resolvePorts(normalized, items)
		return Object.freeze({ revision: this.revision, target: normalized, items: sortItems(items) })
	}

	getGlobalLayout(): ManagementLayout {
		const items: ManagementLayoutItem[] = []
		for (const mounted of this.modules.values()) {
			for (const contribution of mounted.module.contributions) {
				if (contribution.kind !== 'view') continue
				if (contribution.placement === 'plugin.routes') {
					if (!contribution.meta?.route?.addToNav) continue
					if ((contribution.requireRunning ?? true) && !this.isRunning(mounted.owner)) continue
					items.push({
						id: `${mounted.owner}:${contribution.id}`,
						owner: mounted.owner,
						target: mounted.owner,
						placement: contribution.placement,
						view: contribution.view,
						priority: contribution.priority ?? 0,
						requireRunning: contribution.requireRunning ?? true,
						meta: contribution.meta,
						resources: Object.freeze({}),
					})
					continue
				}
				if (!String(contribution.placement).startsWith('global.')) continue
				if ((contribution.requireRunning ?? true) && !this.isRunning(mounted.owner)) continue
				const itemId = `${mounted.owner}:${contribution.id}`
				items.push({
					id: itemId,
					owner: mounted.owner,
					target: mounted.owner,
					placement: contribution.placement,
					view: contribution.view,
					priority: contribution.priority ?? 0,
					requireRunning: contribution.requireRunning ?? true,
					meta: contribution.meta,
					resources: this.grantResources(`global:${itemId}`, mounted.resourceRefs),
				})
			}
		}
		return Object.freeze({ revision: this.revision, target: null, items: sortItems(items) })
	}

	getCatalog(): ManagementCatalog {
		const artifactCatalog = this.artifacts.getCatalog()
		return {
			revision: this.revision,
			modules: artifactCatalog.modules,
			states: artifactCatalog.states,
		}
	}

	getArtifacts(): ManagementArtifactService {
		return this.artifacts
	}

	resolveResource(binding: string, expected?: ManagementResourceRef['kind']): InternalResourceRef {
		const resolved = this.findResource(binding, expected)
		if (!resolved) throw new Error('[management] resource binding is invalid or expired')
		return resolved
	}

	findResource(
		binding: string,
		expected?: ManagementResourceRef['kind'],
	): InternalResourceRef | null {
		const grant = this.grants.get(String(binding ?? ''))
		if (!grant || grant.revision !== this.grantRevision) return null
		if (expected && grant.kind !== expected) {
			throw new Error(`[management] resource binding requires ${expected}, got ${grant.kind}`)
		}
		return Object.freeze({ owner: grant.owner, resource: grant.resource, kind: grant.kind })
	}

	private resolvePorts(target: string, items: ManagementLayoutItem[]): void {
		const targetModule = this.modules.get(target)
		if (!targetModule) return
		const ports = targetModule.module.contributions.filter(
			(item): item is ManagementPortContribution => item.kind === 'port',
		)
		if (ports.length === 0) return

		for (const port of ports) {
			const candidates: Array<{
				mounted: MountedModule
				renderer: ManagementPortRendererContribution
			}> = []
			for (const mounted of this.modules.values()) {
				if (port.providers?.length && !port.providers.includes(mounted.owner)) continue
				if (
					!port.providers?.includes(mounted.owner) &&
					!this.isRequiredDependent(mounted.owner, target)
				)
					continue
				for (const contribution of mounted.module.contributions) {
					if (contribution.kind !== 'port-renderer') continue
					if (!samePort(port, contribution)) continue
					candidates.push({ mounted, renderer: contribution })
				}
			}
			candidates.sort(
				(a, b) =>
					(b.renderer.priority ?? 0) - (a.renderer.priority ?? 0) ||
					a.mounted.owner.localeCompare(b.mounted.owner),
			)
			const selected = candidates[0]
			if (!selected) continue
			if (
				(selected.renderer.requireRunning ?? port.requireRunning ?? true) &&
				!this.isRunning(selected.mounted.owner)
			)
				continue
			const bindings: Record<string, InternalResourceRef> = {
				...selected.mounted.resourceRefs,
			}
			for (const [binding, resource] of Object.entries(port.bindings ?? {})) {
				const ref = targetModule.resourceRefs[resource]
				if (!ref) {
					throw new Error(
						`[management] port "${port.id}" binding "${binding}" references missing resource "${resource}" on "${target}"`,
					)
				}
				const expected = port.port.resources[binding]
				if (!expected) {
					throw new Error(`[management] port "${port.id}" does not declare binding "${binding}"`)
				}
				if (expected.kind !== ref.kind) {
					throw new Error(
						`[management] port "${port.id}" binding "${binding}" requires ${expected.kind}, got ${ref.kind}`,
					)
				}
				bindings[binding] = ref
			}
			const itemId = `${target}:${port.id}<-${selected.mounted.owner}:${selected.renderer.id}`
			items.push({
				id: itemId,
				owner: selected.mounted.owner,
				target,
				placement: port.placement,
				view: selected.renderer.view,
				priority: selected.renderer.priority ?? port.priority ?? 0,
				requireRunning: selected.renderer.requireRunning ?? port.requireRunning ?? true,
				meta: port.meta,
				resources: this.grantResources(`plugin:${target}:${itemId}`, bindings),
			})
		}
	}

	private matchesAudience(owner: string, target: string, audience: ManagementAudience): boolean {
		if (audience.kind === 'self') return owner === target
		if (audience.relations.includes('required') && this.isRequiredDependent(owner, target)) {
			return true
		}
		return false
	}

	private isRequiredDependent(provider: string, consumer: string): boolean {
		const graph = this.ctx.registry.graph
		const providerKey = this.ctx.registry.resolveRuntimeKey(provider as RuntimePluginKey)
		const consumerKey = this.ctx.registry.resolveRuntimeKey(consumer as RuntimePluginKey)
		if (!providerKey || !consumerKey) return false
		return graph.depsOf(consumerKey).includes(providerKey as RuntimePluginKey)
	}

	private isRunning(owner: string): boolean {
		return this.ctx.registry.isRunning(owner as unknown as PluginIdentifier)
	}

	private bump(invalidateResources = true): void {
		this.revision += 1
		if (invalidateResources) {
			this.grantRevision += 1
			this.grants.clear()
			this.grantKeys.clear()
		}
		for (const listener of this.listeners) listener()
	}

	private grantResources(
		scope: string,
		refs: Readonly<Record<string, InternalResourceRef>>,
	): Readonly<Record<string, ManagementResourceRef>> {
		const result: Record<string, ManagementResourceRef> = {}
		for (const [key, ref] of Object.entries(refs)) {
			const grantKey = `${this.grantRevision}:${scope}:${key}:${ref.owner}:${ref.resource}:${ref.kind}`
			let binding = this.grantKeys.get(grantKey)
			if (!binding) {
				binding = randomUUID()
				this.grantKeys.set(grantKey, binding)
				this.grants.set(binding, { ...ref, revision: this.grantRevision })
			}
			result[key] = Object.freeze({ binding, kind: ref.kind })
		}
		return Object.freeze(result)
	}
}

function samePort(
	port: ManagementPortContribution,
	renderer: ManagementPortRendererContribution,
): boolean {
	return port.port.id === renderer.port.id && port.port.version === renderer.port.version
}

function sortItems(items: ManagementLayoutItem[]): readonly ManagementLayoutItem[] {
	items.sort(
		(a, b) =>
			String(a.placement).localeCompare(String(b.placement)) ||
			b.priority - a.priority ||
			a.id.localeCompare(b.id),
	)
	return Object.freeze(items)
}
