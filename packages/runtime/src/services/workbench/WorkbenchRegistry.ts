import {
	BasePlugin,
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type Context,
	type PluginContext,
	type PluginNodeAddress,
	type PluginNodeSlot,
} from '@pluxel/core'
import {
	parseWorkbenchDeclarationIdentity,
	parseWorkbenchOpenableIdentity,
	workbenchOpenableIdentityEqual,
	type WorkbenchAttachmentDeclarationIdentity,
	type WorkbenchAttachmentPlacementIdentity,
	type WorkbenchDeclarationIdentity,
	type WorkbenchViewDeclarationIdentity,
} from '@pluxel/core/federation'
import {
	enterOwnerInvocation,
	getPluginGenerationContext,
	requirePluginService,
} from '@pluxel/core/internal'
import { RpcTarget } from '../../capnweb'
import {
	readWorkbenchDefinition,
	readWorkbenchDescriptor,
	readWorkbenchRendererEntry,
	type AnyWorkbenchDefinition,
	type WorkbenchAttachmentOpenContext,
	type WorkbenchBindings,
	type WorkbenchDefinitionMetadata,
	type WorkbenchDescriptorMetadata,
	type WorkbenchPlacement,
	type WorkbenchPrincipal,
	type WorkbenchTargetFactory,
	type WorkbenchViewOpenContext,
} from '../../workbench/definition'
import type {
	WorkbenchFederatedViewRef,
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchLayoutTarget,
	WorkbenchOpenViewFailureCode,
	WorkbenchOpenViewInput,
	WorkbenchOpenViewResult,
} from '../../workbench/client-protocol'
import type { WorkbenchArtifactLookup } from './WorkbenchArtifactService'

const OPEN_VIEW_TIMEOUT_MS = 15_000
const MAX_OPEN_VIEWS_PER_SESSION = 64
const PROFILE_VERSION = 1 as const

type PublishedView = Readonly<{
	kind: 'view'
	metadata: Extract<WorkbenchDescriptorMetadata, { kind: 'view' }>
	factory: WorkbenchTargetFactory<any>
}>

type PublishedAttachment = Readonly<{
	kind: 'attachment'
	metadata: Extract<WorkbenchDescriptorMetadata, { kind: 'attachment' }>
	factory: (context: WorkbenchAttachmentOpenContext) => RpcTarget | Promise<RpcTarget>
}>

type PublishedAttachmentPlacement = Readonly<{
	kind: 'attachment-placement'
	metadata: Extract<WorkbenchDescriptorMetadata, { kind: 'attachment-placement' }>
	providerOwner: PluginContext
	providerSlot: PluginNodeSlot
	providerKey: string
	consumerFactory?: WorkbenchTargetFactory<any>
}>

type PublishedEntry = PublishedView | PublishedAttachment | PublishedAttachmentPlacement

type PublishedTarget = Readonly<{
	owner: PluginContext
	ownerSlot: PluginNodeSlot
	definition: AnyWorkbenchDefinition
	metadata: WorkbenchDefinitionMetadata
	entries: ReadonlyMap<string, PublishedEntry>
}>

type OpenCandidate = Readonly<{
	target: PublishedTarget
	entry: PublishedView | PublishedAttachmentPlacement
	layoutEntry: WorkbenchLayoutEntry
	params: Readonly<Record<string, string>>
}>

export class WorkbenchRegistry {
	private revisionValue = 0
	private readonly publicationsByContext = new WeakMap<PluginContext, PublishedTarget>()
	private readonly publicationsBySlot = new Map<
		PluginNodeSlot,
		Map<PluginContext, PublishedTarget>
	>()
	private readonly activeBySlot = new Map<PluginNodeSlot, PublishedTarget>()
	private readonly slotWatches = new Map<PluginNodeSlot, () => void>()
	private readonly listeners = new Set<(revision: number) => void>()
	private readonly exportedRoots = new WeakSet<RpcTarget>()

	constructor(
		private readonly root: Context,
		private readonly artifacts: WorkbenchArtifactLookup,
	) {}

	get revision(): number {
		return this.revisionValue
	}

	publish<const Definition extends AnyWorkbenchDefinition>(
		owner: Context,
		definition: Definition,
		bindings: WorkbenchBindings<Definition>,
	): void {
		const pluginOwner = requirePluginContext(owner)
		if (this.publicationsByContext.has(pluginOwner)) {
			throw new Error('[workbench] a Plugin generation can publish only once')
		}

		const publication = this.preparePublication(pluginOwner, definition, bindings)
		this.validateCandidate(publication)

		let byContext = this.publicationsBySlot.get(publication.ownerSlot)
		if (!byContext) {
			byContext = new Map()
			this.publicationsBySlot.set(publication.ownerSlot, byContext)
			const disposeWatch = requirePluginService(this.root).watchInstance(
				publication.ownerSlot,
				(instance) => this.refreshActive(publication.ownerSlot, instance),
			)
			this.slotWatches.set(publication.ownerSlot, disposeWatch)
		}

		byContext.set(pluginOwner, publication)
		this.publicationsByContext.set(pluginOwner, publication)
		this.refreshActive(
			publication.ownerSlot,
			requirePluginService(this.root).getInstance(publication.ownerSlot),
		)

		try {
			owner.effects.defer(() => this.withdraw(publication))
		} catch (error) {
			this.withdraw(publication)
			throw error
		}
	}

	subscribe(listener: (revision: number) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	getLayout(targetAddress: PluginNodeAddress | null): WorkbenchLayout {
		if (targetAddress === null) return this.getGlobalLayout()
		const address = parsePluginNodeAddress(targetAddress)
		const pluginService = requirePluginService(this.root)
		const slot = pluginService.resolvePluginNode(address)
		const publication = slot ? this.activeBySlot.get(slot) : undefined
		const target = this.describeTarget(address, publication)
		const entries = publication
			? [...publication.entries.values()]
					.filter(
						(entry): entry is PublishedView | PublishedAttachmentPlacement =>
							entry.kind !== 'attachment',
					)
					.map((entry) => this.layoutEntry(publication, entry))
					.sort(compareLayoutEntries)
			: []
		return Object.freeze({
			profile: PROFILE_VERSION,
			revision: this.revisionValue,
			target,
			entries: Object.freeze(entries),
		})
	}

	async openView(
		principal: WorkbenchPrincipal,
		sessionSignal: AbortSignal,
		input: WorkbenchOpenViewInput,
		opened: Set<OpenedViewLease>,
	): Promise<WorkbenchOpenViewResult> {
		if (input.layoutRevision !== this.revisionValue) {
			return failure('layout_changed')
		}
		if (opened.size >= MAX_OPEN_VIEWS_PER_SESSION) return failure('quota_exceeded')

		const candidate = this.resolveOpenCandidate(input)
		if (!candidate) return failure('target_unavailable')
		if (sessionSignal.aborted) return failure('target_unavailable')

		const lease = new OpenedViewLease(opened, sessionSignal)
		opened.add(lease)
		let timedOut = false
		const timeout = setTimeout(() => {
			timedOut = true
			lease.abort(new Error('Workbench View factory timed out'))
		}, OPEN_VIEW_TIMEOUT_MS)

		try {
			if (candidate.entry.kind === 'view') {
				const ownerLease = enterOwnerInvocation(candidate.target.owner, lease.signal)
				lease.adoptOwner(ownerLease)
				const api = await this.runFactory(
					candidate.entry.factory,
					Object.freeze({
						principal,
						params: candidate.params,
						signal: lease.signal,
					}),
					lease,
				)
				lease.activate([api])
				return Object.freeze({
					ok: true as const,
					value: Object.freeze({
						kind: 'local' as const,
						api,
						params: candidate.params,
						federatedViewRef: candidate.layoutEntry.federatedViewRef,
					}),
				})
			}

			const providerPublication = this.publicationsByContext.get(candidate.entry.providerOwner)
			const activeProvider = this.activeBySlot.get(candidate.entry.providerSlot)
			const providerEntry = providerPublication?.entries.get(candidate.entry.providerKey)
			if (
				!providerPublication ||
				providerPublication !== activeProvider ||
				providerEntry?.kind !== 'attachment'
			) {
				lease.close()
				return failure('target_unavailable')
			}

			const providerOwnerLease = enterOwnerInvocation(providerPublication.owner, lease.signal)
			const consumerOwnerLease = enterOwnerInvocation(candidate.target.owner, lease.signal)
			lease.adoptOwner(providerOwnerLease)
			lease.adoptOwner(consumerOwnerLease)
			const providerContext: WorkbenchAttachmentOpenContext = Object.freeze({
				principal,
				params: candidate.params,
				signal: lease.signal,
				consumer: Object.freeze({ node: candidate.target.owner.pluginInfo.nodeAddress }),
			})
			const consumerContext: WorkbenchViewOpenContext = Object.freeze({
				principal,
				params: candidate.params,
				signal: lease.signal,
			})
			const roots = await Promise.all([
				this.runFactory(providerEntry.factory, providerContext, lease),
				...(candidate.entry.consumerFactory
					? [this.runFactory(candidate.entry.consumerFactory, consumerContext, lease)]
					: []),
			])
			const provider = roots[0]!
			const consumer = roots[1]
			lease.activate(roots)
			return Object.freeze({
				ok: true as const,
				value: Object.freeze({
					kind: 'attachment' as const,
					provider,
					...(consumer ? { consumer } : {}),
					params: candidate.params,
					federatedViewRef: candidate.layoutEntry.federatedViewRef,
				}),
			})
		} catch (error) {
			lease.close()
			if (timedOut) return failure('factory_timeout')
			if (sessionSignal.aborted || isOwnerClosed(error)) {
				return failure('target_unavailable')
			}
			candidate.target.owner.logger.error('Workbench View factory failed', { error })
			return failure('factory_failed')
		} finally {
			clearTimeout(timeout)
		}
	}

	private preparePublication<const Definition extends AnyWorkbenchDefinition>(
		owner: PluginContext,
		definition: Definition,
		bindings: WorkbenchBindings<Definition>,
	): PublishedTarget {
		const metadata = readWorkbenchDefinition(definition)
		const expectedKeys = metadata.entries.map((entry) => entry.key).sort()
		const bindingRecord = readPlainRecord(bindings, 'bindings')
		const actualKeys = Object.keys(bindingRecord).sort()
		if (!sameStrings(expectedKeys, actualKeys)) {
			const missing = expectedKeys.filter((key) => !actualKeys.includes(key))
			const extra = actualKeys.filter((key) => !expectedKeys.includes(key))
			throw new TypeError(
				`[workbench] bindings must exactly match definition` +
					`${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
					`${extra.length > 0 ? `; extra: ${extra.join(', ')}` : ''}`,
			)
		}

		const entries = new Map<string, PublishedEntry>()
		for (const descriptor of metadata.entries) {
			const binding = bindingRecord[descriptor.key]
			switch (descriptor.kind) {
				case 'view': {
					entries.set(
						descriptor.key,
						Object.freeze({
							kind: 'view',
							metadata: descriptor,
							factory: requireFactory(binding, `bindings.${descriptor.key}`),
						}),
					)
					break
				}
				case 'attachment': {
					entries.set(
						descriptor.key,
						Object.freeze({
							kind: 'attachment',
							metadata: descriptor,
							factory: requireFactory(binding, `bindings.${descriptor.key}`),
						}),
					)
					break
				}
				case 'attachment-placement': {
					entries.set(descriptor.key, this.prepareAttachmentPlacement(owner, descriptor, binding))
					break
				}
			}
		}

		return Object.freeze({
			owner,
			ownerSlot: owner.pluginInfo.nodeSlot,
			definition,
			metadata,
			entries,
		})
	}

	private prepareAttachmentPlacement(
		owner: PluginContext,
		metadata: Extract<WorkbenchDescriptorMetadata, { kind: 'attachment-placement' }>,
		binding: unknown,
	): PublishedAttachmentPlacement {
		const record = readPlainRecord(binding, `bindings.${metadata.key}`)
		const keys = Object.keys(record).sort()
		if (
			!sameStrings(keys, record.consumer === undefined ? ['provider'] : ['consumer', 'provider'])
		) {
			throw new TypeError(
				`[workbench] bindings.${metadata.key} must contain provider and optional consumer only`,
			)
		}
		if (!(record.provider instanceof BasePlugin)) {
			throw new TypeError(
				`[workbench] bindings.${metadata.key}.provider must be a Plugin dependency`,
			)
		}
		const providerOwner = requirePluginContext(getPluginGenerationContext(record.provider))
		const providerSlot = providerOwner.pluginInfo.nodeSlot
		if (
			!requirePluginService(this.root)
				.graph.depsOf(owner.pluginInfo.nodeSlot)
				.includes(providerSlot)
		) {
			throw new TypeError(
				`[workbench] bindings.${metadata.key}.provider must be a direct required dependency`,
			)
		}

		const providerMetadata = readWorkbenchDescriptor(metadata.provider)
		if (providerMetadata.kind !== 'attachment') {
			throw new TypeError(`[workbench] ${metadata.key} has an invalid provider descriptor`)
		}
		const providerPublication = this.publicationsByContext.get(providerOwner)
		const providerEntry = providerPublication?.entries.get(providerMetadata.key)
		if (!providerPublication || providerEntry?.kind !== 'attachment') {
			throw new TypeError(
				`[workbench] bindings.${metadata.key}.provider did not publish the required Attachment`,
			)
		}
		assertSameRendererProvenance(providerMetadata, providerEntry.metadata)

		return Object.freeze({
			kind: 'attachment-placement',
			metadata,
			providerOwner,
			providerSlot,
			providerKey: providerMetadata.key,
			...(record.consumer === undefined
				? {}
				: {
						consumerFactory: requireFactory(record.consumer, `bindings.${metadata.key}.consumer`),
					}),
		})
	}

	private validateCandidate(candidate: PublishedTarget): void {
		for (const entry of candidate.entries.values()) {
			if (entry.kind !== 'view' && entry.kind !== 'attachment') continue
			const descriptor = parseWorkbenchDeclarationIdentity({
				kind: entry.kind,
				owner: candidate.owner.pluginInfo.definitionAddress,
				key: entry.metadata.key,
			})
			if (!this.artifacts.resolveEntry(candidate.owner.pluginInfo.definitionAddress, descriptor)) {
				throw new TypeError(
					`[workbench] no committed federation artifact for ${entry.kind} "${entry.metadata.key}"`,
				)
			}
		}

		const exactRoutes = new Map<string, string>()
		const parameterized: Array<{ path: string; owner: string }> = []
		for (const entry of candidate.entries.values()) {
			if (entry.kind === 'attachment') continue
			const placement = entry.metadata.placement
			if (placement.kind !== 'route') continue
			const owner = `${pluginNodeIndexKey(candidate.owner.pluginInfo.nodeAddress)}:${entry.metadata.key}`
			if (placement.path.includes('/:')) {
				for (const existing of parameterized) {
					if (routePatternsOverlap(existing.path, placement.path)) {
						throw new TypeError(
							`[workbench] ambiguous parameterized routes: ${existing.path} (${existing.owner}) and ${placement.path} (${owner})`,
						)
					}
				}
				parameterized.push({ path: placement.path, owner })
			} else {
				const existing = exactRoutes.get(placement.path)
				if (existing) {
					throw new TypeError(
						`[workbench] duplicate exact route ${placement.path}: ${existing} and ${owner}`,
					)
				}
				exactRoutes.set(placement.path, owner)
			}
		}

		const publications = [...this.activeBySlot.values()].filter(
			(publication) => publication.ownerSlot !== candidate.ownerSlot,
		)
		publications.push(candidate)
		const groups = new Map<string, Readonly<{ label: string; icon?: string }>>()
		for (const publication of publications) {
			for (const entry of publication.entries.values()) {
				if (entry.kind === 'attachment') continue
				const placement = entry.metadata.placement
				if (placement.kind !== 'route') continue
				const group = placement.navigation?.group
				if (!group) continue
				const existing = groups.get(group.id)
				if (existing && (existing.label !== group.label || existing.icon !== group.icon)) {
					throw new TypeError(`[workbench] navigation group "${group.id}" has conflicting metadata`)
				}
				groups.set(group.id, Object.freeze({ label: group.label, icon: group.icon }))
			}
		}
	}

	private getGlobalLayout(): WorkbenchLayout {
		const entries: WorkbenchLayoutEntry[] = []
		for (const publication of this.activeBySlot.values()) {
			for (const entry of publication.entries.values()) {
				if (entry.kind === 'attachment') continue
				const placement = entry.metadata.placement
				if (placement.kind !== 'route' || !placement.navigation) continue
				entries.push(this.layoutEntry(publication, entry))
			}
		}
		entries.sort(compareLayoutEntries)
		return Object.freeze({
			profile: PROFILE_VERSION,
			revision: this.revisionValue,
			target: null,
			entries: Object.freeze(entries),
		})
	}

	private layoutEntry(
		target: PublishedTarget,
		entry: PublishedView | PublishedAttachmentPlacement,
	): WorkbenchLayoutEntry {
		if (entry.kind === 'view') {
			const descriptor = parseWorkbenchOpenableIdentity({
				kind: 'view',
				owner: target.owner.pluginInfo.definitionAddress,
				key: entry.metadata.key,
			}) as WorkbenchViewDeclarationIdentity
			return Object.freeze({
				descriptor,
				target: this.describeTarget(target.owner.pluginInfo.nodeAddress, target),
				renderer: target.owner.pluginInfo.nodeAddress,
				definitionRevisions: Object.freeze({
					target: target.owner.pluginInfo.definitionRevision,
					renderer: target.owner.pluginInfo.definitionRevision,
				}),
				placement: entry.metadata.placement,
				federatedViewRef: this.federatedViewRef(target, descriptor),
			})
		}

		const provider = this.publicationsByContext.get(entry.providerOwner)
		if (!provider || provider !== this.activeBySlot.get(entry.providerSlot)) {
			throw new Error('[workbench] active Attachment provider publication is unavailable')
		}
		const providerIdentity: WorkbenchAttachmentDeclarationIdentity = {
			kind: 'attachment',
			owner: provider.owner.pluginInfo.definitionAddress,
			key: entry.providerKey,
		}
		const descriptor = parseWorkbenchOpenableIdentity({
			kind: 'attachment-placement',
			consumer: target.owner.pluginInfo.definitionAddress,
			key: entry.metadata.key,
			provider: providerIdentity,
		}) as WorkbenchAttachmentPlacementIdentity
		return Object.freeze({
			descriptor,
			target: this.describeTarget(target.owner.pluginInfo.nodeAddress, target),
			renderer: provider.owner.pluginInfo.nodeAddress,
			definitionRevisions: Object.freeze({
				target: target.owner.pluginInfo.definitionRevision,
				renderer: provider.owner.pluginInfo.definitionRevision,
			}),
			placement: entry.metadata.placement,
			federatedViewRef: this.federatedViewRef(provider, descriptor.provider),
		})
	}

	private federatedViewRef(
		publication: PublishedTarget,
		descriptor: WorkbenchDeclarationIdentity,
	): WorkbenchFederatedViewRef {
		const resolved = this.artifacts.resolveEntry(
			publication.owner.pluginInfo.definitionAddress,
			descriptor,
		)
		if (!resolved) {
			throw new Error(
				`[workbench] committed federation artifact withdrew ${descriptor.kind} "${descriptor.key}"`,
			)
		}
		const { artifact, entry } = resolved
		return Object.freeze({
			profile: artifact.profile,
			producer: artifact.producer,
			buildRevision: artifact.buildRevision,
			manifestUrl: artifact.manifestUrl,
			expose: entry.expose,
			descriptor,
		})
	}

	private resolveOpenCandidate(input: WorkbenchOpenViewInput): OpenCandidate | null {
		const pluginService = requirePluginService(this.root)
		const slot = pluginService.resolvePluginNode(input.target)
		const target = slot ? this.activeBySlot.get(slot) : undefined
		if (!target) return null
		const metadata = target.entries.get(input.descriptor.key)
		if (!metadata || metadata.kind === 'attachment') return null
		const layoutEntry = this.layoutEntry(target, metadata)
		if (!workbenchOpenableIdentityEqual(layoutEntry.descriptor, input.descriptor)) return null
		const params = matchPlacement(metadata.metadata.placement, input.location)
		if (!params) return null
		return Object.freeze({ target, entry: metadata, layoutEntry, params })
	}

	private async runFactory(
		factory: (context: any) => RpcTarget | Promise<RpcTarget>,
		context: WorkbenchViewOpenContext | WorkbenchAttachmentOpenContext,
		lease: OpenedViewLease,
	): Promise<RpcTarget> {
		const pending = Promise.resolve().then(() => factory(context))
		lease.trackPending(pending)
		const target = await pending
		if (!(target instanceof RpcTarget)) {
			throw new TypeError('Workbench factory must return a fresh RpcTarget')
		}
		if (this.exportedRoots.has(target)) {
			throw new TypeError('Workbench factory returned an RpcTarget that was already exported')
		}
		this.exportedRoots.add(target)
		if (lease.signal.aborted) {
			throw lease.signal.reason
		}
		lease.reserve(target)
		return target
	}

	private refreshActive(slot: PluginNodeSlot, instance: BasePlugin | undefined): void {
		const next = instance
			? this.publicationsBySlot.get(slot)?.get(requirePluginContext(instance.ctx))
			: undefined
		const previous = this.activeBySlot.get(slot)
		if (previous === next) return
		if (next) this.activeBySlot.set(slot, next)
		else this.activeBySlot.delete(slot)
		this.bump()
	}

	private withdraw(publication: PublishedTarget): void {
		if (this.publicationsByContext.get(publication.owner) !== publication) return
		this.publicationsByContext.delete(publication.owner)
		const byContext = this.publicationsBySlot.get(publication.ownerSlot)
		byContext?.delete(publication.owner)
		this.refreshActive(
			publication.ownerSlot,
			requirePluginService(this.root).getInstance(publication.ownerSlot),
		)
		if (byContext && byContext.size === 0) {
			this.publicationsBySlot.delete(publication.ownerSlot)
			this.slotWatches.get(publication.ownerSlot)?.()
			this.slotWatches.delete(publication.ownerSlot)
		}
	}

	private describeTarget(
		address: PluginNodeAddress,
		publication: PublishedTarget | undefined,
	): WorkbenchLayoutTarget {
		return Object.freeze({
			node: address,
			displayName: publication?.owner.pluginInfo.displayName ?? address.definition.exportName,
		})
	}

	private bump(): void {
		this.revisionValue += 1
		for (const listener of this.listeners) listener(this.revisionValue)
	}
}

export class OpenedViewLease {
	private readonly controller = new AbortController()
	private readonly ownerLeases: Array<{ signal: AbortSignal; dispose(): void }> = []
	private readonly reserved = new Set<RpcTarget>()
	private readonly roots = new Map<RpcTarget, (() => void) | undefined>()
	private active = true

	readonly signal: AbortSignal

	constructor(
		private readonly opened: Set<OpenedViewLease>,
		sessionSignal: AbortSignal,
	) {
		this.signal = AbortSignal.any([sessionSignal, this.controller.signal])
		this.signal.addEventListener('abort', () => this.close(), { once: true })
	}

	adoptOwner(lease: { signal: AbortSignal; dispose(): void }): void {
		if (!this.active) {
			lease.dispose()
			return
		}
		this.ownerLeases.push(lease)
		if (lease.signal.aborted) this.abort(lease.signal.reason)
		else {
			lease.signal.addEventListener('abort', () => this.abort(lease.signal.reason), {
				once: true,
			})
		}
	}

	trackPending(pending: Promise<RpcTarget>): void {
		void pending.then(
			(target): undefined => {
				if (!this.active && target instanceof RpcTarget) disposeTarget(target)
				return undefined
			},
			(_error): undefined => undefined,
		)
	}

	reserve(target: RpcTarget): void {
		if (!this.active) {
			disposeTarget(target)
			throw this.signal.reason ?? new Error('Workbench View was closed')
		}
		this.reserved.add(target)
	}

	activate(targets: readonly RpcTarget[]): void {
		if (!this.active || this.signal.aborted) throw this.signal.reason
		for (const target of targets) {
			if (!this.reserved.has(target)) {
				throw new Error('Workbench root activation lost its reservation')
			}
			this.installRootDisposer(target)
			this.reserved.delete(target)
		}
	}

	abort(reason: unknown): void {
		if (!this.controller.signal.aborted) this.controller.abort(reason)
	}

	close(): void {
		if (!this.active) return
		this.active = false
		if (!this.controller.signal.aborted) {
			this.controller.abort(new Error('Workbench View closed'))
		}
		for (const target of this.reserved) disposeTarget(target)
		this.reserved.clear()
		for (const [target, dispose] of this.roots) {
			this.roots.delete(target)
			invokeDisposer(dispose)
		}
		for (const owner of this.ownerLeases.splice(0).toReversed()) owner.dispose()
		this.opened.delete(this)
	}

	private installRootDisposer(target: RpcTarget): void {
		const own = Object.getOwnPropertyDescriptor(target, Symbol.dispose)
		if (own && !own.configurable) {
			throw new TypeError('Workbench root has a non-configurable own disposer')
		}
		const inherited = (target as RpcTarget & Partial<Disposable>)[Symbol.dispose]
		const original = typeof inherited === 'function' ? inherited.bind(target) : undefined
		this.roots.set(target, original)
		Object.defineProperty(target, Symbol.dispose, {
			configurable: false,
			enumerable: false,
			value: () => this.releaseRoot(target),
			writable: false,
		})
	}

	private releaseRoot(target: RpcTarget): void {
		if (!this.roots.has(target)) return
		const dispose = this.roots.get(target)
		this.roots.delete(target)
		try {
			invokeDisposer(dispose)
		} finally {
			this.close()
		}
	}
}

function requirePluginContext(ctx: Context): PluginContext {
	if (!('pluginInfo' in ctx)) {
		throw new TypeError('[workbench] publication requires a Plugin generation Context')
	}
	return ctx as PluginContext
}

function requireFactory(
	value: unknown,
	label: string,
): (context: any) => RpcTarget | Promise<RpcTarget> {
	if (typeof value !== 'function') throw new TypeError(`[workbench] ${label} must be a factory`)
	return value as (context: any) => RpcTarget | Promise<RpcTarget>
}

function readPlainRecord(value: unknown, label: string): Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`[workbench] ${label} must be a plain record`)
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`[workbench] ${label} must be a plain record`)
	}
	return value as Record<string, any>
}

function assertSameRendererProvenance(
	placed: Extract<WorkbenchDescriptorMetadata, { kind: 'attachment' }>,
	published: Extract<WorkbenchDescriptorMetadata, { kind: 'attachment' }>,
): void {
	const left = readWorkbenchRendererEntry(placed.renderer)
	const right = readWorkbenchRendererEntry(published.renderer)
	if (left.moduleUrl !== right.moduleUrl || left.entryPath !== right.entryPath) {
		throw new TypeError('[workbench] placed Attachment does not belong to the bound provider')
	}
}

function matchPlacement(
	placement: WorkbenchPlacement,
	location: string | undefined,
): Readonly<Record<string, string>> | null {
	if (placement.kind === 'tab') return location === undefined ? Object.freeze({}) : null
	if (typeof location !== 'string' || !location.startsWith('/') || location.includes('?'))
		return null
	const expected = placement.path.split('/').slice(1)
	const actual = location.replace(/\/+$/, '').split('/').slice(1)
	if (expected.length !== actual.length) return null
	const params: Record<string, string> = Object.create(null)
	for (let index = 0; index < expected.length; index += 1) {
		const pattern = expected[index]!
		const segment = actual[index]!
		if (!segment) return null
		if (!pattern.startsWith(':')) {
			if (pattern !== segment) return null
			continue
		}
		let decoded: string
		try {
			decoded = decodeURIComponent(segment)
		} catch {
			return null
		}
		if (!decoded || decoded.includes('/') || decoded.includes('\\') || decoded.length > 512) {
			return null
		}
		params[pattern.slice(1)] = decoded
	}
	return Object.freeze(params)
}

function routePatternsOverlap(left: string, right: string): boolean {
	const leftSegments = left.split('/').slice(1)
	const rightSegments = right.split('/').slice(1)
	if (leftSegments.length !== rightSegments.length) return false
	return leftSegments.every((segment, index) => {
		const other = rightSegments[index]!
		return segment.startsWith(':') || other.startsWith(':') || segment === other
	})
}

function compareLayoutEntries(left: WorkbenchLayoutEntry, right: WorkbenchLayoutEntry): number {
	return (
		left.placement.kind.localeCompare(right.placement.kind) ||
		left.placement.order - right.placement.order ||
		pluginNodeIndexKey(left.target.node).localeCompare(pluginNodeIndexKey(right.target.node)) ||
		left.descriptor.key.localeCompare(right.descriptor.key)
	)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index])
}

function failure(code: WorkbenchOpenViewFailureCode): WorkbenchOpenViewResult {
	return Object.freeze({ ok: false, code })
}

function isOwnerClosed(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes('owner stopped') || error.message.includes('View closed'))
	)
}

function disposeTarget(target: RpcTarget): void {
	const dispose = (target as RpcTarget & Partial<Disposable>)[Symbol.dispose]
	if (typeof dispose === 'function') invokeDisposer(dispose.bind(target))
}

function invokeDisposer(dispose: (() => void) | undefined): void {
	if (!dispose) return
	try {
		dispose()
	} catch {
		// Cleanup remains idempotent even when a Plugin disposer is faulty.
	}
}
