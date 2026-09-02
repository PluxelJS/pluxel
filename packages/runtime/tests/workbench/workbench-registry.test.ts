import { pluginNodeAddressOf, type Context } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { workbenchFederationExpose, workbenchFederationProducerName } from '@pluxel/core/federation'
import { RpcTarget, type RpcStub } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { requireWorkbench, WorkbenchBackend } from '../../src/services/workbench'
import type { WorkbenchArtifactLookup } from '../../src/services/workbench/WorkbenchArtifactService'
import type { WorkbenchContentArtifactLookup } from '../../src/services/workbench/WorkbenchContentArtifactService'
import type { WorkbenchContentObserver } from '@pluxel/runtime/workbench/client'

interface SettingsApi extends RpcTarget {
	snapshot(): Readonly<{ enabled: boolean }>
}

interface CatalogApi extends RpcTarget {
	list(): readonly string[]
}

interface SelectionApi extends RpcTarget {
	select(id: string): boolean
}

const renderer = workbench.entry(import.meta.url, './fixtures/settings.tsx')

const LocalWorkbench = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer,
		placement: workbench.tab({ label: 'Settings' }),
	}),
})

const ContentWorkbench = workbench.define({
	guide: workbench.content({
		document: workbench.markdown(import.meta.url, './fixtures/guide.md'),
		placement: workbench.tab({ label: 'Guide' }),
	}),
})

const InteractiveContentWorkbench = workbench.define({
	interactive: workbench.content({
		document: workbench.markdown(import.meta.url, './fixtures/interactive.md', {
			status: workbench.data(v.object({ count: v.number() })),
			refresh: workbench.action({ label: 'Refresh' }),
		}),
		placement: workbench.tab({ label: 'Interactive' }),
	}),
})

const RoutedWorkbench = workbench.define({
	account: workbench.view<SettingsApi>({
		renderer,
		placement: workbench.route('/accounts/:accountId', { title: 'Account' }),
	}),
})

const SharedRouteWorkbenchA = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer,
		placement: workbench.route('/settings', { title: 'Settings A' }),
	}),
})

const SharedRouteWorkbenchB = workbench.define({
	settings: workbench.view<SettingsApi>({
		renderer,
		placement: workbench.route('/settings', { title: 'Settings B' }),
	}),
})

const ProviderWorkbench = workbench.define({
	picker: workbench.attachment<CatalogApi, SelectionApi>({ renderer }),
})

const ConsumerWorkbench = workbench.define({
	fonts: ProviderWorkbench.picker.place(workbench.tab({ label: 'Fonts' })),
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
		this.ctx.workbench?.publish(LocalWorkbench, {
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
		this.ctx.workbench?.publish(ContentWorkbench)
	}
}

let contentCount = 0
let contentChanged: (() => void) | undefined
let contentSignal: AbortSignal | undefined

@Plugin({ displayName: 'Interactive Content' })
class InteractiveContentPlugin extends BasePlugin {
	protected override init() {
		this.ctx.workbench?.publish(InteractiveContentWorkbench, {
			interactive: ({ dataChanged, signal }) => {
				contentChanged = dataChanged
				contentSignal = signal
				return {
					load: () => ({ status: { count: contentCount } }),
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

@Plugin({ displayName: 'No publication' })
class NoPublicationPlugin extends BasePlugin {}

let reusedTarget: SettingsTarget | undefined
let reusedFactory: PromiseWithResolvers<SettingsTarget> | undefined
let reusedFactoryStarted: PromiseWithResolvers<void> | undefined

@Plugin({ displayName: 'Reused target' })
class ReusedTargetPlugin extends BasePlugin {
	protected override init() {
		this.ctx.workbench?.publish(LocalWorkbench, {
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
		this.ctx.workbench?.publish(LocalWorkbench, {
			settings: ({ signal }) => {
				lateFactorySignal = signal
				lateFactoryStarted?.resolve()
				if (!lateFactory) throw new Error('late factory test was not initialized')
				return lateFactory.promise
			},
		})
	}
}

let routedParams: Readonly<Record<string, string>> | undefined

@Plugin({ displayName: 'Routed' })
class RoutedPlugin extends BasePlugin {
	protected override init() {
		this.ctx.workbench?.publish(RoutedWorkbench, {
			account: ({ params, signal }) => {
				routedParams = params
				return new SettingsTarget(signal)
			},
		})
	}
}

@Plugin({ displayName: 'Shared route A' })
class SharedRoutePluginA extends BasePlugin {
	protected override init() {
		this.ctx.workbench?.publish(SharedRouteWorkbenchA, {
			settings: ({ signal }) => new SettingsTarget(signal),
		})
	}
}

@Plugin({ displayName: 'Shared route B' })
class SharedRoutePluginB extends BasePlugin {
	protected override init() {
		this.ctx.workbench?.publish(SharedRouteWorkbenchB, {
			settings: ({ signal }) => new SettingsTarget(signal),
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

@Plugin({ displayName: 'Provider' })
class ProviderPlugin extends BasePlugin {
	protected override init() {
		this.ctx.workbench?.publish(ProviderWorkbench, {
			picker: ({ consumer }) => {
				attachmentConsumerNode = consumer.node
				return new CatalogTarget(consumer.node.definition.exportName)
			},
		})
	}
}

@Plugin({ displayName: 'Consumer' })
class ConsumerPlugin extends BasePlugin {
	constructor(private readonly provider: ProviderPlugin) {
		super()
	}

	protected override init() {
		this.ctx.workbench?.publish(ConsumerWorkbench, {
			fonts: {
				provider: this.provider,
				consumer: () => new SelectionTarget(),
			},
		})
	}
}

describe('Workbench vNext publication', () => {
	it('rejects an explicit undefined binding for a binding-free Content definition', async () => {
		const host = createRuntimeHost()
		host.add(NoPublicationPlugin)
		host.start(NoPublicationPlugin)
		await host.commit()

		try {
			const instance = requirePluginService(host.ctx).getInstance(
				pluginNodeAddressOf(NoPublicationPlugin),
			)
			if (!instance) throw new Error('NoPublicationPlugin did not start')
			const registry = requireWorkbench(host.ctx).registry as unknown as {
				publish(owner: Context, definition: unknown, ...bindings: unknown[]): void
			}

			expect(() => registry.publish(instance.ctx, ContentWorkbench, undefined)).toThrow(
				'bindings must be omitted for a binding-free definition',
			)
		} finally {
			await host.dispose()
		}
	})

	it('opens a static Content without a target, retained lease, or View quota', async () => {
		const host = createRuntimeHost()
		host.add(ContentPlugin)
		host.start(ContentPlugin)
		await host.commit()

		try {
			const backend = requireWorkbench(host.ctx)
			const session = backend.createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(ContentPlugin)
			const layout = session.target.layout({ target })
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
		} finally {
			await host.dispose()
		}
	})

	it('opens interactive Content on one framework root and releases its lifetime lease', async () => {
		contentCount = 0
		contentChanged = undefined
		contentSignal = undefined
		const host = createRuntimeHost()
		host.add(InteractiveContentPlugin)
		host.start(InteractiveContentPlugin)
		await host.commit()

		try {
			const session = requireWorkbench(host.ctx).createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(InteractiveContentPlugin)
			const layout = session.target.layout({ target })
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
			) as unknown as Parameters<typeof opened.value.root.subscribe>[0] & WorkbenchContentObserver
			await expect(opened.value.root.subscribe(observer)).resolves.toMatchObject({
				ok: true,
				data: { status: { count: 0 } },
			})
			await expect(opened.value.root.run('refresh')).resolves.toMatchObject({
				action: { ok: true },
				data: { ok: true, data: { status: { count: 1 } } },
			})

			contentCount = 2
			contentChanged?.()
			await vi.waitFor(() => expect(updates).toHaveLength(1))
			expect(updates[0]).toMatchObject({ ok: true, data: { status: { count: 2 } } })

			opened.value.root[Symbol.dispose]()
			expect(contentSignal?.aborted).toBe(true)
			expect(disposeObserver).toHaveBeenCalledTimes(1)
			session.dispose()
		} finally {
			await host.dispose()
		}
	})

	it('aborts the Content lifetime and releases opened quota when an observer rejects', async () => {
		contentCount = 0
		contentChanged = undefined
		contentSignal = undefined
		const host = createRuntimeHost()
		host.add(InteractiveContentPlugin)
		host.start(InteractiveContentPlugin)
		await host.commit()

		try {
			const session = requireWorkbench(host.ctx).createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(InteractiveContentPlugin)
			const layout = session.target.layout({ target })
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
			await opened.value.root.subscribe(retained.observer)

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
		} finally {
			await host.dispose()
		}
	})

	it('aborts the Content lifetime when an observer throws synchronously', async () => {
		contentChanged = undefined
		contentSignal = undefined
		const host = createRuntimeHost()
		host.add(InteractiveContentPlugin)
		host.start(InteractiveContentPlugin)
		await host.commit()

		try {
			const session = requireWorkbench(host.ctx).createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(InteractiveContentPlugin)
			const layout = session.target.layout({ target })
			const opened = await session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			})
			if (!opened.ok || opened.value.kind !== 'content' || opened.value.mode !== 'interactive') {
				throw new Error('interactive Content open failed')
			}
			const lifetime = contentSignal
			if (!lifetime) throw new Error('Content factory did not receive its lifetime signal')
			const disposeObserver = vi.fn()
			const observer = Object.assign(
				vi.fn(() => {
					throw new Error('synchronous callback failure')
				}),
				{
					dup: () => observer,
					[Symbol.dispose]: disposeObserver,
				},
			) as unknown as Parameters<typeof opened.value.root.subscribe>[0]
			await opened.value.root.subscribe(observer)

			contentChanged?.()
			await vi.waitFor(() => expect(lifetime.aborted).toBe(true))
			expect(disposeObserver).toHaveBeenCalledTimes(1)
			session.dispose()
		} finally {
			await host.dispose()
		}
	})

	it('keeps layout capability-free and opens one fresh root lazily', async () => {
		localFactoryCalls = 0
		disposedTargets.length = 0
		const host = createRuntimeHost()
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()

		try {
			const backend = requireWorkbench(host.ctx)
			let invalidated = false
			const session = backend.createSession(localPrincipal, () => {
				invalidated = true
			})
			const target = pluginNodeAddressOf(LocalPlugin)
			const layout = session.target.layout({ target })

			expect(layout.entries).toHaveLength(1)
			expect(localFactoryCalls).toBe(0)
			expect(layout.entries[0]).not.toHaveProperty('api')

			const result = await session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			})
			expect(result.ok).toBe(true)
			expect(localFactoryCalls).toBe(1)
			if (!result.ok || result.value.kind !== 'local') throw new Error('open failed')
			const openedTarget = result.value.api as SettingsTarget
			expect(openedTarget.snapshot()).toEqual({ enabled: true })

			session.dispose()
			expect(openedTarget.disposed).toBe(true)
			expect(openedTarget.signal.aborted).toBe(true)
			expect(invalidated).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('opens ready entries after producer-status-only layout revisions', async () => {
		localFactoryCalls = 0
		const host = createRuntimeHost()
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()

		try {
			const target = pluginNodeAddressOf(LocalPlugin)
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
			const layout = session.target.layout({ target })

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
		} finally {
			await host.dispose()
		}
	})

	it('keeps federated entries visible while their producer artifact is unavailable', async () => {
		const host = createRuntimeHost()
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()

		try {
			const target = pluginNodeAddressOf(LocalPlugin)
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
			const building = session.target.layout({ target })
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
		} finally {
			await host.dispose()
		}
	})

	it('rejects federated publications without artifacts outside development pending mode', async () => {
		const host = createRuntimeHost()
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()

		try {
			const target = pluginNodeAddressOf(LocalPlugin)
			const instance = requirePluginService(host.ctx).getInstance(target)
			if (!instance) throw new Error('LocalPlugin did not start')
			const pendingOnlyBackend = new WorkbenchBackend(
				host.ctx,
				{},
				Object.freeze({ resolveEntry: () => undefined }),
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
				Object.freeze({ resolveEntry: () => undefined }),
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
		} finally {
			await host.dispose()
		}
	})

	it('rejects an RpcTarget that a factory already exported', async () => {
		reusedTarget = undefined
		reusedFactory = undefined
		reusedFactoryStarted = undefined
		disposedTargets.length = 0
		const host = createRuntimeHost()
		host.add(ReusedTargetPlugin)
		host.start(ReusedTargetPlugin)
		await host.commit()

		try {
			const backend = requireWorkbench(host.ctx)
			const session = backend.createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(ReusedTargetPlugin)
			const layout = session.target.layout({ target })
			const input = {
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			}
			const first = await session.target.openEntry(input)
			expect(first.ok).toBe(true)
			const firstTarget = reusedTarget
			expect(firstTarget?.disposed).toBe(false)

			await expect(session.target.openEntry(input)).resolves.toEqual({
				ok: false,
				code: 'factory_failed',
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
		const host = createRuntimeHost()
		host.add(ReusedTargetPlugin)
		host.start(ReusedTargetPlugin)
		await host.commit()

		try {
			const backend = requireWorkbench(host.ctx)
			const target = pluginNodeAddressOf(ReusedTargetPlugin)
			const firstSession = backend.createSession(localPrincipal, () => {})
			const firstLayout = firstSession.target.layout({ target })
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
			const secondLayout = secondSession.target.layout({ target })
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

	it('disposes a factory target once when it resolves after session close', async () => {
		disposedTargets.length = 0
		lateFactory = Promise.withResolvers<SettingsTarget>()
		lateFactoryStarted = Promise.withResolvers<void>()
		lateFactorySignal = undefined
		const host = createRuntimeHost()
		host.add(LateFactoryPlugin)
		host.start(LateFactoryPlugin)
		await host.commit()
		let resolvedTarget: SettingsTarget | undefined

		try {
			const backend = requireWorkbench(host.ctx)
			const session = backend.createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(LateFactoryPlugin)
			const layout = session.target.layout({ target })
			const opening = session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			})
			await lateFactoryStarted.promise

			session.dispose()
			expect(lateFactorySignal?.aborted).toBe(true)
			resolvedTarget = new SettingsTarget(lateFactorySignal!)
			lateFactory.resolve(resolvedTarget)
			await expect(opening).resolves.toEqual({ ok: false, code: 'target_unavailable' })
			expect(resolvedTarget.disposed).toBe(true)
			expect(disposedTargets.filter((candidate) => candidate === resolvedTarget)).toHaveLength(1)
		} finally {
			await host.dispose()
			lateFactory = undefined
			lateFactoryStarted = undefined
			lateFactorySignal = undefined
		}
		expect(disposedTargets.filter((candidate) => candidate === resolvedTarget)).toHaveLength(1)
	})

	it('returns factory_timeout before a non-cooperative factory settles', async () => {
		disposedTargets.length = 0
		lateFactory = Promise.withResolvers<SettingsTarget>()
		lateFactoryStarted = Promise.withResolvers<void>()
		lateFactorySignal = undefined
		const host = createRuntimeHost()
		host.add(LateFactoryPlugin)
		host.start(LateFactoryPlugin)
		await host.commit()
		let fakeTimers = false
		let resolvedTarget: SettingsTarget | undefined

		try {
			const backend = requireWorkbench(host.ctx)
			const session = backend.createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(LateFactoryPlugin)
			const layout = session.target.layout({ target })
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
			await expect(opening).resolves.toEqual({ ok: false, code: 'factory_timeout' })
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

	it('server-rematches parameterized routes and rejects browser params', async () => {
		routedParams = undefined
		const host = createRuntimeHost()
		host.add(RoutedPlugin)
		host.start(RoutedPlugin)
		await host.commit()
		try {
			const backend = requireWorkbench(host.ctx)
			const session = backend.createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(RoutedPlugin)
			const layout = session.target.layout({ target })
			const result = await session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
				location: '/accounts/account%201',
			})
			expect(result.ok).toBe(true)
			expect(routedParams).toEqual({ accountId: 'account 1' })
			await expect(
				session.target.openEntry({
					layoutRevision: layout.revision,
					target,
					descriptor: layout.entries[0]!.descriptor,
					location: '/other/account%201',
				}),
			).resolves.toEqual({ ok: false, code: 'target_unavailable' })
			session.dispose()
		} finally {
			await host.dispose()
		}
	})

	it('scopes identical route paths to their target Plugin', async () => {
		const host = createRuntimeHost()
		host.add([SharedRoutePluginA, SharedRoutePluginB])
		host.start(SharedRoutePluginA)
		host.start(SharedRoutePluginB)
		await host.commit()
		try {
			const backend = requireWorkbench(host.ctx)
			const session = backend.createSession(localPrincipal, () => {})
			const layoutA = session.target.layout({ target: pluginNodeAddressOf(SharedRoutePluginA) })
			const layoutB = session.target.layout({ target: pluginNodeAddressOf(SharedRoutePluginB) })
			expect(layoutA.entries[0]?.placement).toMatchObject({ path: '/settings' })
			expect(layoutB.entries[0]?.placement).toMatchObject({ path: '/settings' })
			session.dispose()
		} finally {
			await host.dispose()
		}
	})

	it('opens an Attachment through one exact required edge', async () => {
		attachmentConsumerNode = undefined
		const host = createRuntimeHost()
		host.add([ProviderPlugin, ConsumerPlugin])
		host.start(ProviderPlugin)
		host.start(ConsumerPlugin)
		await host.commit()
		try {
			const backend = requireWorkbench(host.ctx)
			const session = backend.createSession(localPrincipal, () => {})
			const target = pluginNodeAddressOf(ConsumerPlugin)
			const layout = session.target.layout({ target })
			expect(layout.entries).toHaveLength(1)
			expect(layout.entries[0]!.descriptor).toMatchObject({
				kind: 'attachment-placement',
				key: 'fonts',
				provider: { kind: 'attachment', key: 'picker' },
			})

			const result = await session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			})
			expect(result.ok).toBe(true)
			if (!result.ok || result.value.kind !== 'attachment') throw new Error('open failed')
			expect(result.value).toHaveProperty('provider')
			expect(result.value).toHaveProperty('consumer')
			expect(attachmentConsumerNode).toEqual(target)
			session.dispose()
		} finally {
			await host.dispose()
		}
	})

	it('expires the whole socket epoch and opened root on owner withdrawal', async () => {
		const host = createRuntimeHost()
		host.add(LocalPlugin)
		host.start(LocalPlugin)
		await host.commit()
		try {
			const backend = requireWorkbench(host.ctx)
			let invalidation: Error | undefined
			const session = backend.createSession(localPrincipal, (cause) => {
				invalidation = cause
			})
			const target = pluginNodeAddressOf(LocalPlugin)
			const layout = session.target.layout({ target })
			const result = await session.target.openEntry({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
			})
			if (!result.ok || result.value.kind !== 'local') throw new Error('open failed')
			const openedTarget = result.value.api as SettingsTarget

			host.stop(LocalPlugin)
			await host.commit()
			expect(openedTarget.signal.aborted).toBe(true)
			expect(openedTarget.disposed).toBe(true)
			expect(session.signal.aborted).toBe(true)
			expect(invalidation?.message).toContain('publication changed')
		} finally {
			await host.dispose()
		}
	})
})

const localPrincipal = Object.freeze({ provider: 'local', subject: 'local' })

const emptyContentLookup: WorkbenchContentArtifactLookup = Object.freeze({
	resolveContent: () => undefined,
})

function mutableWorkbenchArtifactLookup(): Readonly<{
	lookup: WorkbenchArtifactLookup
	setReady(): void
}> {
	let ready = false
	return Object.freeze({
		lookup: Object.freeze({
			resolveEntry(definition, descriptor) {
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
