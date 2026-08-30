import { pluginNodeAddressOf } from '@pluxel/core'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { requireWorkbench } from '../../src/services/workbench'

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

			const result = await session.target.openView({
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
			const result = await session.target.openView({
				layoutRevision: layout.revision,
				target,
				descriptor: layout.entries[0]!.descriptor,
				location: '/accounts/account%201',
			})
			expect(result.ok).toBe(true)
			expect(routedParams).toEqual({ accountId: 'account 1' })
			await expect(
				session.target.openView({
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

			const result = await session.target.openView({
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
			const result = await session.target.openView({
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
