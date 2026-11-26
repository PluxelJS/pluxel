import { type Workbench, workbench } from '@pluxel/workbench'
import { parsePluginNodeAddress, defineServiceRef, formatPluginNodeReference } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { workbenchFederationExpose, workbenchFederationProducerName } from '@pluxel/core/federation'
import { RpcTarget, type RpcStub } from 'capnweb'
import { createServiceInternalTestHarness } from '@pluxel/services/internal/test'
import { BasePlugin, Plugin } from '@pluxel/core/internal/test'
import { describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { WorkbenchHost, WorkbenchBackend } from '@pluxel/workbench/server'
import {
	WorkbenchContentTarget,
	type WorkbenchArtifactLookup,
	type WorkbenchContentArtifactLookup,
} from '@pluxel/workbench/internal'
import type { WorkbenchContentObserver } from '@pluxel/workbench/client'

const WorkbenchRef = defineServiceRef<Workbench>()
interface SettingsApi extends RpcTarget {
	snapshot(): Readonly<{ enabled: boolean }>
}

interface CatalogApi extends RpcTarget {
	list(): readonly string[]
}

interface SelectionApi extends RpcTarget {
	select(id: string): boolean
}

const renderer = './fixtures/settings.tsx'

const LocalWorkbench = workbench.define(import.meta.url, {
	settings: workbench.view<SettingsApi>({
		renderer,
		placement: { kind: 'tab', label: 'Settings' },
	}),
})

const ContentWorkbench = workbench.define(import.meta.url, {
	guide: workbench.content({
		document: './fixtures/guide.md',
		placement: { kind: 'tab', label: 'Guide' },
	}),
})

const InteractiveContentWorkbench = workbench.define(import.meta.url, {
	interactive: workbench.content({
		document: './fixtures/interactive.md',
		slots: {
			status: workbench.data(v.object({ count: v.number() })),
			refresh: workbench.action({ label: 'Refresh' }),
		},
		placement: { kind: 'tab', label: 'Interactive' },
	}),
})

const ProviderWorkbench = workbench.define(import.meta.url, {
	picker: workbench.attachment<CatalogApi, SelectionApi>({ renderer }),
})

const PanelWorkbench = workbench.define(import.meta.url, {
	inspector: workbench.view<SettingsApi>({
		renderer,
		placement: { kind: 'panel', region: 'right', label: 'Inspector' },
	}),
	guide: workbench.content({
		document: './fixtures/guide.md',
		placement: { kind: 'panel', region: 'left', label: 'Guide' },
	}),
	fonts: ProviderWorkbench.picker.place({ kind: 'panel', region: 'bottom', label: 'Fonts' }),
})

const disposedTargets: SettingsTarget[] = []
let localFactoryCalls = 0

class SettingsTarget extends RpcTarget implements SettingsApi {
	disposed = false

	constructor(readonly signal: AbortSignal) {
		super()
	}

	snapshot() {
		return { enabled: true }
	}

	[Symbol.dispose]() {
		this.disposed = true
		disposedTargets.push(this)
	}
}

@Plugin({ displayName: 'Local' })
class LocalPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(LocalWorkbench, {
			settings: ({ signal }) => {
				localFactoryCalls += 1
				return new SettingsTarget(signal)
			},
		})
	}
}

@Plugin({ displayName: 'Content' })
class ContentPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(ContentWorkbench)
	}
}

let contentCount = 0
let contentChanged: (() => void) | undefined
let contentSignal: AbortSignal | undefined
let contentSubscriptions = 0
let contentUnsubscribed = 0

@Plugin({ displayName: 'Interactive Content' })
class InteractiveContentPlugin extends BasePlugin {
	factoryGate?: Promise<void>
	failFactory = false
	failSubscribe = false
	loadCalls = 0

	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(InteractiveContentWorkbench, {
			interactive: async ({ signal }) => {
				contentSignal = signal
				if (this.factoryGate) await this.factoryGate
				if (this.failFactory) throw new Error('Content factory failed')
				return {
					subscribe: (changed) => {
						if (this.failSubscribe) throw new Error('Content subscription failed')
						contentSubscriptions += 1
						contentChanged = changed
						return {
							[Symbol.dispose]: () => {
								contentUnsubscribed += 1
							},
						}
					},
					load: () => {
						this.loadCalls += 1
						return { status: { count: contentCount } }
					},
					actions: {
						refresh: () => {
							contentCount += 1
						},
					},
				}
			},
		})
	}
}

function retainedContentObserver(handler: () => void | Promise<void>) {
	const disposeObserver = vi.fn()
	const disposeResults: ReturnType<typeof vi.fn>[] = []
	const observer = Object.assign(
		vi.fn(() => {
			const disposeResult = vi.fn()
			disposeResults.push(disposeResult)
			const result = Promise.resolve(handler())
			return Object.assign(result, { [Symbol.dispose]: disposeResult })
		}),
		{
			dup: () => observer,
			[Symbol.dispose]: disposeObserver,
		},
	) as unknown as RpcStub<WorkbenchContentObserver>
	return { observer, disposeObserver, disposeResults }
}

let reusedTarget: SettingsTarget | undefined
let reusedFactory: PromiseWithResolvers<SettingsTarget> | undefined
let reusedFactoryStarted: PromiseWithResolvers<void> | undefined

@Plugin({ displayName: 'Reused target' })
class ReusedTargetPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(LocalWorkbench, {
			settings: ({ signal }) => {
				if (reusedFactory) {
					reusedFactoryStarted?.resolve()
					return reusedFactory.promise
				}
				reusedTarget ??= new SettingsTarget(signal)
				return reusedTarget
			},
		})
	}
}

let lateFactory: PromiseWithResolvers<SettingsTarget> | undefined
let lateFactoryStarted: PromiseWithResolvers<void> | undefined
let lateFactorySignal: AbortSignal | undefined

@Plugin({ displayName: 'Late factory' })
class LateFactoryPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(LocalWorkbench, {
			settings: ({ signal }) => {
				lateFactorySignal = signal
				lateFactoryStarted?.resolve()
				if (!lateFactory) throw new Error('late factory test was not initialized')
				return lateFactory.promise
			},
		})
	}
}

class CatalogTarget extends RpcTarget implements CatalogApi {
	constructor(readonly consumer: string) {
		super()
	}

	list() {
		return ['a', 'b']
	}
}

class SelectionTarget extends RpcTarget implements SelectionApi {
	select(_id: string) {
		return true
	}
}

let attachmentConsumerNode: unknown

@Plugin({ displayName: 'Provider', forkable: true })
class ProviderPlugin extends BasePlugin {
	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(ProviderWorkbench, {
			picker: ({ consumer }) => {
				attachmentConsumerNode = consumer.node
				return new CatalogTarget(consumer.node.definition.exportName)
			},
		})
	}
}

@Plugin({ forkable: true })
class AttachmentBindingConsumer extends BasePlugin {
	constructor(readonly provider: ProviderPlugin) {
		super()
	}
}

@Plugin({ displayName: 'Panel owner' })
class PanelPlugin extends BasePlugin {
	constructor(private readonly provider: ProviderPlugin) {
		super()
	}

	protected override init() {
		this.ctx.service(WorkbenchRef)?.publish(PanelWorkbench, {
			inspector: ({ signal }) => new SettingsTarget(signal),
			fonts: { provider: this.provider, consumer: () => new SelectionTarget() },
		})
	}
}

describe('Workbench publication', () => {
	it('identifies the consumer binding, expected Attachment and actual provider fork on rejection', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add([ProviderPlugin, AttachmentBindingConsumer])
		const selected = host.fork(ProviderPlugin, 'selected')
		const consumer = host.fork(AttachmentBindingConsumer, 'reports')
		host.override(consumer, ProviderPlugin, selected)
		host.start(ProviderPlugin)
		host.start(consumer)
		await host.commit()

		const owner = host.require(consumer)
		const service = owner.ctx.service(WorkbenchRef)!
		const other = workbench.define('https://user:secret@example.test/reports.ts?token=private', {
			picker: workbench.attachment<CatalogApi, SelectionApi>({ renderer }),
			missing: workbench.attachment<CatalogApi, SelectionApi>({ renderer }),
		})
		const publish = (attachment: typeof ProviderWorkbench.picker, provider: BasePlugin) =>
			service.publish(
				workbench.define(import.meta.url, {
					fonts: attachment.place({ kind: 'tab', label: 'Fonts' }),
				}),
				{ fonts: { provider, consumer: () => new SelectionTarget() } },
			)

		const binding = `${formatPluginNodeReference(consumer)} bindings.fonts.provider`
		const selectedNode = formatPluginNodeReference(selected)
		const actual = formatPluginNodeReference(ProviderPlugin.nodeAddress())
		expect(() => publish(other.picker, host.require(ProviderPlugin))).toThrow(
			`${binding} must be a direct required dependency (expected Attachment "picker" from https://example.test/reports.ts (renderer ${renderer}), bound ${actual})`,
		)
		expect(() => publish(other.missing, owner.provider)).toThrow(
			`${binding} expected Attachment "missing" from https://example.test/reports.ts (renderer ${renderer}), but ${selectedNode} did not publish that entry`,
		)
		expect(() => publish(other.picker, owner.provider)).toThrow(
			`${binding} expected Attachment "picker" from https://example.test/reports.ts (renderer ${renderer}), but ${selectedNode} published a different declaration: Attachment "picker" from`,
		)
		publish(ProviderWorkbench.picker, owner.provider)
	})

	it('opens owner-scoped panel Views, Content and Attachments without route locations', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add([ProviderPlugin, PanelPlugin, LocalPlugin])
		host.start(ProviderPlugin)
		host.start(PanelPlugin)
		host.start(LocalPlugin)
		await host.commit()
		const backend = host.ctx.service(WorkbenchHost)
		const session = backend.createSession(localPrincipal, () => {})
		const target = PanelPlugin.nodeAddress()
		const layout = session.target.layoutDto({ target })
		const panels = Object.fromEntries(layout.entries.map((entry) => [entry.descriptor.key, entry]))
		expect(Object.keys(panels).sort()).toEqual(['fonts', 'guide', 'inspector'])
		expect(
			session.target.layoutDto({ target: null }).entries.map((entry) => entry.descriptor.key),
		).toEqual(['settings'])
		const input = (key: string) => ({
			layoutRevision: layout.revision,
			target,
			descriptor: panels[key]!.descriptor,
		})
		await expect(
			session.target.openEntry({ ...input('inspector'), target: LocalPlugin.nodeAddress() }),
		).resolves.toMatchObject({ ok: false, code: 'target_unavailable' })
		await expect(
			session.target.openEntry({ ...input('inspector'), location: '/not-a-route' }),
		).resolves.toMatchObject({ ok: false, code: 'target_unavailable' })
		await expect(session.target.openEntry(input('guide'))).resolves.toMatchObject({
			ok: true,
			value: { kind: 'content', mode: 'static' },
		})
		await expect(session.target.openEntry(input('fonts'))).resolves.toMatchObject({
			ok: true,
			value: {
				kind: 'attachment',
				provider: expect.any(CatalogTarget),
				consumer: expect.any(SelectionTarget),
			},
		})
		expect(attachmentConsumerNode).toEqual(parsePluginNodeAddress(target))
		const opened = await session.target.openEntry(input('inspector'))
		if (!opened.ok || opened.value.kind !== 'local') throw new Error('Panel View did not open')
		const inspector = opened.value.api as SettingsTarget
		host.stop(PanelPlugin)
		await host.commit()
		expect(inspector.signal.aborted).toBe(true)
		expect(inspector.disposed).toBe(true)
		expect(session.signal.aborted).toBe(true)
		session.dispose()
	})

	it('opens a static Content without a target, retained lease, or View quota', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(ContentPlugin)
		host.start(ContentPlugin)
		await host.commit()

		const backend = host.ctx.service(WorkbenchHost)
		const session = backend.createSession(localPrincipal, () => {})
		const target = ContentPlugin.nodeAddress()
		const layout = session.target.layoutDto({ target })
		expect(layout.entries).toHaveLength(1)
		const entry = layout.entries[0]!
		expect(entry.descriptor).toMatchObject({ kind: 'content', key: 'guide' })
		expect(entry).toHaveProperty('contentRef')
		expect(entry).not.toHaveProperty('renderer')
		expect(entry).not.toHaveProperty('federatedViewRef')

		for (let index = 0; index < 65; index += 1) {
			const result = await session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: entry.descriptor,
			})
			expect(result.ok).toBe(true)
			if (!result.ok || result.value.kind !== 'content') throw new Error('Content open failed')
			expect(result.value).not.toHaveProperty('api')
			expect(result.value).not.toHaveProperty('provider')
			expect(result.value.plan).toEqual({
				version: 1,
				kind: 'workbench-content',
				document: { version: 1, blocks: [] },
				slots: [],
			})
		}

		host.stop(ContentPlugin)
		await host.commit()
		expect(session.signal.aborted).toBe(true)
	})

	it('opens interactive Content on one framework root and releases its lifetime lease', async () => {
		const subscriptionsBefore = contentSubscriptions
		const disposedBefore = contentUnsubscribed
		contentCount = 0
		contentChanged = undefined
		contentSignal = undefined
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(InteractiveContentPlugin)
		host.start(InteractiveContentPlugin)
		await host.commit()

		const session = host.ctx.service(WorkbenchHost).createSession(localPrincipal, () => {})
		const target = InteractiveContentPlugin.nodeAddress()
		const layout = session.target.layoutDto({ target })
		const entry = layout.entries[0]!
		const opened = await session.target.openEntry({
			layoutRevision: layout.revision,
			target,
			descriptor: entry.descriptor,
		})
		expect(opened.ok).toBe(true)
		if (!opened.ok || opened.value.kind !== 'content' || opened.value.mode !== 'interactive') {
			throw new Error('interactive Content open failed')
		}
		expect(contentSubscriptions - subscriptionsBefore).toBe(1)
		const owner = requirePluginService(host.ctx).getInstance(target) as InteractiveContentPlugin
		expect(owner.loadCalls).toBe(0)
		expect(opened.value.presentation.slots.map((slot) => slot.key)).toEqual(['refresh', 'status'])
		const updates: unknown[] = []
		const disposeObserver = vi.fn()
		const observer = Object.assign(
			(outcome: unknown) =>
				Object.assign(
					Promise.resolve().then(() => updates.push(outcome)),
					{
						[Symbol.dispose]: vi.fn(),
					},
				),
			{
				dup: () => observer,
				[Symbol.dispose]: disposeObserver,
			},
		) as unknown as Parameters<typeof opened.value.root.subscribeDto>[0] & WorkbenchContentObserver
		await expect(opened.value.root.subscribeDto(observer)).resolves.toMatchObject({
			ok: true,
			data: { status: { count: 0 } },
		})
		await expect(opened.value.root.runDto('refresh')).resolves.toMatchObject({
			action: { ok: true },
			data: { ok: true, data: { status: { count: 1 } } },
		})

		contentCount = 2
		contentChanged?.()
		await vi.waitFor(() => expect(updates).toHaveLength(1))
		expect(updates[0]).toMatchObject({ ok: true, data: { status: { count: 2 } } })

		if (!(opened.value.root instanceof WorkbenchContentTarget))
			throw new Error('expected local Content root')
		opened.value.root[Symbol.dispose]()
		expect(contentUnsubscribed - disposedBefore).toBe(1)
		expect(contentSignal?.aborted).toBe(true)
		expect(disposeObserver).toHaveBeenCalledTimes(1)
		session.dispose()
		expect(contentUnsubscribed - disposedBefore).toBe(1)
	})

	it.each(['session', 'provider'] as const)(
		'releases every Content subscription once on %s closure',
		async (boundary) => {
			const subscriptionsBefore = contentSubscriptions
			const disposedBefore = contentUnsubscribed
			await using host = await createServiceInternalTestHarness({ workbench: true })
			host.add(InteractiveContentPlugin)
			host.start(InteractiveContentPlugin)
			await host.commit()
			const session = host.ctx.service(WorkbenchHost).createSession(localPrincipal, () => {})
			const target = InteractiveContentPlugin.nodeAddress()
			const layout = session.target.layoutDto({ target })
			for (let index = 0; index < 2; index += 1) {
				await expect(
					session.target.openEntry({
						layoutRevision: layout.revision,
						target,
						descriptor: layout.entries[0]!.descriptor,
					}),
				).resolves.toMatchObject({ ok: true })
			}
			expect(contentSubscriptions - subscriptionsBefore).toBe(2)
			if (boundary === 'provider') {
				host.stop(InteractiveContentPlugin)
				await host.commit()
			} else session.dispose()
			expect(contentSignal?.aborted).toBe(true)
			expect(contentUnsubscribed - disposedBefore).toBe(2)
			session.dispose()
			expect(contentUnsubscribed - disposedBefore).toBe(2)
		},
	)

	it.each(['factory', 'subscription'] as const)(
		'does not retain an open when Content %s creation fails',
		async (stage) => {
			const subscriptionsBefore = contentSubscriptions
			await using host = await createServiceInternalTestHarness({ workbench: true })
			host.add(InteractiveContentPlugin)
			host.start(InteractiveContentPlugin)
			await host.commit()
			const target = InteractiveContentPlugin.nodeAddress()
			const owner = requirePluginService(host.ctx).getInstance(target) as InteractiveContentPlugin
			if (stage === 'factory') owner.failFactory = true
			else owner.failSubscribe = true
			const session = host.ctx.service(WorkbenchHost).createSession(localPrincipal, () => {})
			const layout = session.target.layoutDto({ target })
			const input = {
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			}
			await expect(session.target.openEntry(input)).resolves.toMatchObject({
				ok: false,
				code: 'factory_failed',
			})
			expect(contentSignal?.aborted).toBe(true)
			expect(contentSubscriptions).toBe(subscriptionsBefore)
			expect(owner.loadCalls).toBe(0)
			owner.failFactory = false
			owner.failSubscribe = false
			await expect(session.target.openEntry(input)).resolves.toMatchObject({ ok: true })
			session.dispose()
		},
	)

	it('does not subscribe a Content factory result that arrives after the session closes', async () => {
		const subscriptionsBefore = contentSubscriptions
		contentSignal = undefined
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(InteractiveContentPlugin)
		host.start(InteractiveContentPlugin)
		await host.commit()
		const target = InteractiveContentPlugin.nodeAddress()
		const owner = requirePluginService(host.ctx).getInstance(target) as InteractiveContentPlugin
		const gate = Promise.withResolvers<void>()
		owner.factoryGate = gate.promise
		const session = host.ctx.service(WorkbenchHost).createSession(localPrincipal, () => {})
		const layout = session.target.layoutDto({ target })
		const opening = session.target.openEntry({
			layoutRevision: layout.revision,
			target,
			descriptor: layout.entries[0]!.descriptor,
		})
		await vi.waitFor(() => expect(contentSignal).toBeDefined())
		session.dispose()
		await expect(opening).resolves.toMatchObject({ ok: false, code: 'target_unavailable' })
		gate.resolve()
		await gate.promise
		await Promise.resolve()
		expect(contentSubscriptions).toBe(subscriptionsBefore)
		expect(owner.loadCalls).toBe(0)
	})

	it('aborts the Content lifetime and releases opened quota when an observer rejects', async () => {
		contentCount = 0
		contentChanged = undefined
		contentSignal = undefined
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(InteractiveContentPlugin)
		host.start(InteractiveContentPlugin)
		await host.commit()

		const session = host.ctx.service(WorkbenchHost).createSession(localPrincipal, () => {})
		const target = InteractiveContentPlugin.nodeAddress()
		const layout = session.target.layoutDto({ target })
		const input = {
			layoutRevision: layout.revision,
			target,
			descriptor: layout.entries[0]!.descriptor,
		}
		const opened = await session.target.openEntry(input)
		if (!opened.ok || opened.value.kind !== 'content' || opened.value.mode !== 'interactive') {
			throw new Error('interactive Content open failed')
		}
		const lifetime = contentSignal
		if (!lifetime) throw new Error('Content factory did not receive its lifetime signal')
		const retained = retainedContentObserver(() => Promise.reject(new Error('browser gone')))
		await opened.value.root.subscribeDto(retained.observer)

		contentChanged?.()
		await vi.waitFor(() => expect(lifetime.aborted).toBe(true))
		expect(retained.disposeObserver).toHaveBeenCalledTimes(1)
		expect(retained.disposeResults[0]).toHaveBeenCalledTimes(1)

		for (let index = 0; index < 64; index += 1) {
			await expect(session.target.openEntry(input)).resolves.toMatchObject({ ok: true })
		}
		await expect(session.target.openEntry(input)).resolves.toEqual({
			ok: false,
			code: 'quota_exceeded',
		})
		session.dispose()
	})

	it('opens ready entries after producer-status-only layout revisions', async () => {
		localFactoryCalls = 0
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()

		const target = LocalPlugin.nodeAddress()
		const instance = requirePluginService(host.ctx).getInstance(target)
		if (!instance) throw new Error('LocalPlugin did not start')
		const artifacts = mutableWorkbenchArtifactLookup()
		artifacts.setReady()
		const backend = new WorkbenchBackend(host.ctx, {}, artifacts.lookup, emptyContentLookup)
		backend.producerStatus.enablePendingProducerBuilds()
		backend.publish(instance.ctx, LocalWorkbench, {
			settings: ({ signal }) => {
				localFactoryCalls += 1
				return new SettingsTarget(signal)
			},
		})
		const session = backend.createSession(localPrincipal, () => {})
		const layout = session.target.layoutDto({ target })

		backend.producerStatus.setBuilding({
			definition: target.definition,
			producer: workbenchFederationProducerName(target.definition),
			buildRevision: 'pending-build',
		})

		const result = await session.target.openEntry({
			layoutRevision: layout.revision,
			target,
			descriptor: layout.entries[0]!.descriptor,
		})
		expect(result.ok).toBe(true)
		expect(localFactoryCalls).toBe(1)
		session.dispose()
	})

	it('keeps federated entries visible while their producer artifact is unavailable', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()

		const target = LocalPlugin.nodeAddress()
		const instance = requirePluginService(host.ctx).getInstance(target)
		if (!instance) throw new Error('LocalPlugin did not start')
		const artifacts = mutableWorkbenchArtifactLookup()
		const backend = new WorkbenchBackend(host.ctx, {}, artifacts.lookup, emptyContentLookup)
		backend.producerStatus.enablePendingProducerBuilds()
		backend.producerStatus.setBuilding({
			definition: target.definition,
			producer: workbenchFederationProducerName(target.definition),
			buildRevision: 'pending-build',
		})
		backend.publish(instance.ctx, LocalWorkbench, {
			settings: ({ signal }) => new SettingsTarget(signal),
		})

		let invalidated: Error | undefined
		const session = backend.createSession(localPrincipal, (cause) => {
			invalidated = cause
		})
		const building = session.target.layoutDto({ target })
		expect(building.entries).toHaveLength(1)
		expect(building.entries[0]).toMatchObject({
			descriptor: { kind: 'view', key: 'settings' },
			federatedViewUnavailable: { reason: 'building' },
		})
		expect(building.entries[0]).not.toHaveProperty('federatedViewRef')
		await expect(
			backend.registry.openEntry(
				localPrincipal,
				new AbortController().signal,
				{
					layoutRevision: building.revision,
					target,
					descriptor: {
						kind: 'view',
						owner: target.definition,
						key: 'settings',
					},
				},
				new Set(),
			),
		).resolves.toEqual({ ok: false, code: 'target_unavailable' })

		backend.producerStatus.setFailed({
			definition: target.definition,
			producer: workbenchFederationProducerName(target.definition),
			buildRevision: 'failed-build',
			error: new Error('renderer syntax error'),
		})
		expect(session.signal.aborted).toBe(false)
		expect(invalidated).toBeUndefined()
		const failed = backend.registry.getLayout(target)
		expect(failed.revision).toBeGreaterThan(building.revision)
		expect(failed.entries).toHaveLength(1)
		expect(failed.entries[0]).toMatchObject({
			descriptor: { kind: 'view', key: 'settings' },
			federatedViewUnavailable: {
				reason: 'failed',
				message: 'renderer syntax error',
			},
		})

		artifacts.setReady()
		const visible = backend.registry.getLayout(target)
		expect(visible.entries).toHaveLength(1)
		expect(visible.entries[0]).toMatchObject({
			descriptor: { kind: 'view', key: 'settings' },
			federatedViewRef: {
				producer: workbenchFederationProducerName(target.definition),
				buildRevision: 'ready-build',
				expose: workbenchFederationExpose('settings'),
			},
		})
		expect(visible.entries[0]).not.toHaveProperty('federatedViewUnavailable')
	})

	it('rejects federated publications without artifacts outside development pending mode', async () => {
		await using host = await createServiceInternalTestHarness({ workbench: true })
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()

		const target = LocalPlugin.nodeAddress()
		const instance = requirePluginService(host.ctx).getInstance(target)
		if (!instance) throw new Error('LocalPlugin did not start')
		const pendingOnlyBackend = new WorkbenchBackend(
			host.ctx,
			{},
			Object.freeze({
				resolveEntry: (): ReturnType<WorkbenchArtifactLookup['resolveEntry']> => undefined,
			}),
			emptyContentLookup,
		)
		pendingOnlyBackend.producerStatus.enablePendingProducerBuilds()

		expect(() =>
			pendingOnlyBackend.publish(instance.ctx, LocalWorkbench, {
				settings: ({ signal }) => new SettingsTarget(signal),
			}),
		).toThrow('no committed federation artifact for view "settings"')

		const strictStatusBackend = new WorkbenchBackend(
			host.ctx,
			{},
			Object.freeze({
				resolveEntry: (): ReturnType<WorkbenchArtifactLookup['resolveEntry']> => undefined,
			}),
			emptyContentLookup,
		)
		strictStatusBackend.producerStatus.setFailed({
			definition: target.definition,
			producer: workbenchFederationProducerName(target.definition),
			buildRevision: 'failed-build',
			error: new Error('renderer syntax error'),
		})

		expect(() =>
			strictStatusBackend.publish(instance.ctx, LocalWorkbench, {
				settings: ({ signal }) => new SettingsTarget(signal),
			}),
		).toThrow('no committed federation artifact for view "settings"')
	})

	it('identifies a factory result from the wrong RpcTarget runtime', async () => {
		reusedTarget = {} as SettingsTarget
		reusedFactory = undefined
		const host = await createServiceInternalTestHarness({ workbench: true })
		host.add(ReusedTargetPlugin)
		host.start(ReusedTargetPlugin)
		await host.commit()
		try {
			const session = host.ctx.service(WorkbenchHost).createSession(localPrincipal, () => {})
			const target = ReusedTargetPlugin.nodeAddress()
			const layout = session.target.layoutDto({ target })
			await expect(
				session.target.openEntry({
					layoutRevision: layout.revision,
					target,
					descriptor: layout.entries[0]!.descriptor,
				}),
			).resolves.toMatchObject({
				ok: false,
				code: 'invalid_target',
				diagnosticId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			})
			session.dispose()
		} finally {
			await host.dispose()
			reusedTarget = undefined
		}
	})

	it('rejects an RpcTarget that a factory already exported', async () => {
		reusedTarget = undefined
		reusedFactory = undefined
		reusedFactoryStarted = undefined
		disposedTargets.length = 0
		const host = await createServiceInternalTestHarness({ workbench: true })
		host.add(ReusedTargetPlugin)
		host.start(ReusedTargetPlugin)
		await host.commit()

		try {
			const backend = host.ctx.service(WorkbenchHost)
			const session = backend.createSession(localPrincipal, () => {})
			const target = ReusedTargetPlugin.nodeAddress()
			const layout = session.target.layoutDto({ target })
			const input = {
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			}
			const first = await session.target.openEntry(input)
			expect(first.ok).toBe(true)
			const firstTarget = reusedTarget
			expect(firstTarget?.disposed).toBe(false)

			await expect(session.target.openEntry(input)).resolves.toMatchObject({
				ok: false,
				code: 'reused_target',
				diagnosticId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			})
			expect(firstTarget?.disposed).toBe(false)

			session.dispose()
			expect(firstTarget?.disposed).toBe(true)
			expect(disposedTargets.filter((candidate) => candidate === firstTarget)).toHaveLength(1)
		} finally {
			await host.dispose()
			reusedTarget = undefined
			reusedFactory = undefined
			reusedFactoryStarted = undefined
		}
	})

	it('does not dispose another session root when a late factory reuses it', async () => {
		reusedTarget = undefined
		reusedFactory = undefined
		reusedFactoryStarted = undefined
		disposedTargets.length = 0
		const host = await createServiceInternalTestHarness({ workbench: true })
		host.add(ReusedTargetPlugin)
		host.start(ReusedTargetPlugin)
		await host.commit()

		try {
			const backend = host.ctx.service(WorkbenchHost)
			const target = ReusedTargetPlugin.nodeAddress()
			const firstSession = backend.createSession(localPrincipal, () => {})
			const firstLayout = firstSession.target.layoutDto({ target })
			const first = await firstSession.target.openEntry({
				layoutRevision: firstLayout.revision,
				target,
				descriptor: firstLayout.entries[0]!.descriptor,
			})
			if (!first.ok || first.value.kind !== 'local') throw new Error('first open failed')
			const firstTarget = first.value.api as SettingsTarget

			reusedFactory = Promise.withResolvers<SettingsTarget>()
			reusedFactoryStarted = Promise.withResolvers<void>()
			const secondSession = backend.createSession(localPrincipal, () => {})
			const secondLayout = secondSession.target.layoutDto({ target })
			const secondOpening = secondSession.target.openEntry({
				layoutRevision: secondLayout.revision,
				target,
				descriptor: secondLayout.entries[0]!.descriptor,
			})
			await reusedFactoryStarted.promise

			secondSession.dispose()
			reusedFactory.resolve(firstTarget)
			await expect(secondOpening).resolves.toEqual({
				ok: false,
				code: 'target_unavailable',
			})
			expect(firstTarget.disposed).toBe(false)
			expect(firstTarget.signal.aborted).toBe(false)

			firstSession.dispose()
			expect(firstTarget.disposed).toBe(true)
			expect(disposedTargets.filter((candidate) => candidate === firstTarget)).toHaveLength(1)
		} finally {
			await host.dispose()
			reusedTarget = undefined
			reusedFactory = undefined
			reusedFactoryStarted = undefined
		}
	})

	it('returns factory_timeout before a non-cooperative factory settles', async () => {
		disposedTargets.length = 0
		lateFactory = Promise.withResolvers<SettingsTarget>()
		lateFactoryStarted = Promise.withResolvers<void>()
		lateFactorySignal = undefined
		const host = await createServiceInternalTestHarness({ workbench: true })
		host.add(LateFactoryPlugin)
		host.start(LateFactoryPlugin)
		await host.commit()
		let fakeTimers = false
		let resolvedTarget: SettingsTarget | undefined

		try {
			const backend = host.ctx.service(WorkbenchHost)
			const session = backend.createSession(localPrincipal, () => {})
			const target = LateFactoryPlugin.nodeAddress()
			const layout = session.target.layoutDto({ target })
			vi.useFakeTimers()
			fakeTimers = true
			const opening = session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			})
			await lateFactoryStarted.promise

			await vi.advanceTimersByTimeAsync(14_999)
			let settled = false
			void opening.then((): undefined => {
				settled = true
				return undefined
			})
			await Promise.resolve()
			expect(settled).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			await expect(opening).resolves.toMatchObject({
				ok: false,
				code: 'factory_timeout',
				diagnosticId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			})
			expect(lateFactorySignal?.aborted).toBe(true)

			resolvedTarget = new SettingsTarget(lateFactorySignal!)
			lateFactory.resolve(resolvedTarget)
			vi.useRealTimers()
			fakeTimers = false
			await vi.waitFor(() => expect(resolvedTarget?.disposed).toBe(true))
			expect(disposedTargets.filter((candidate) => candidate === resolvedTarget)).toHaveLength(1)

			session.dispose()
		} finally {
			if (fakeTimers) vi.useRealTimers()
			await host.dispose()
			lateFactory = undefined
			lateFactoryStarted = undefined
			lateFactorySignal = undefined
		}
		expect(disposedTargets.filter((candidate) => candidate === resolvedTarget)).toHaveLength(1)
	})
})

const localPrincipal = Object.freeze({ provider: 'local', subject: 'local' })

const emptyContentLookup: WorkbenchContentArtifactLookup = Object.freeze({
	resolveContent: (): ReturnType<WorkbenchContentArtifactLookup['resolveContent']> => undefined,
})

function mutableWorkbenchArtifactLookup(): Readonly<{
	lookup: WorkbenchArtifactLookup
	setReady(): void
}> {
	let ready = false
	return Object.freeze({
		lookup: Object.freeze({
			resolveEntry(
				...[definition, descriptor]: Parameters<WorkbenchArtifactLookup['resolveEntry']>
			) {
				if (!ready) return undefined
				const producer = workbenchFederationProducerName(definition)
				const buildRevision = 'ready-build'
				const entry = Object.freeze({
					descriptor,
					expose: workbenchFederationExpose(descriptor.key),
				})
				return Object.freeze({
					artifact: Object.freeze({
						profile: 1,
						definition,
						producer,
						buildRevision,
						manifestUrl: `/__pluxel/runtime/federation/${producer}/${buildRevision}/mf-manifest.json`,
						manifestSha256: '0'.repeat(64),
						entries: Object.freeze([entry]),
					}),
					entry,
				})
			},
		}),
		setReady() {
			ready = true
		},
	})
}
