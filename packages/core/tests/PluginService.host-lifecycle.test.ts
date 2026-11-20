import type { CoreHostConfig } from '@pluxel/core'
import type { CoreCommitPublication, CorePluginLifecycleHooks } from '@pluxel/core/internal'
import { createCoreContextHost } from '@pluxel/core/host'
import {
	BasePlugin,
	Plugin,
	PluginPart,
	assertPluginLifecycleIssue,
	createCoreInternalTestHost,
	definePluginRef,
} from '@pluxel/core/internal/test'
import { expect, it, vi } from 'vitest'

function hostWithHooks(hooks: CorePluginLifecycleHooks, execution?: CoreHostConfig['execution']) {
	return createCoreInternalTestHost(
		{ execution },
		{
			createRootContext: (config) =>
				createCoreContextHost({ ...config, createLifecycleHooks: () => hooks }).createRoot(),
		},
	)
}

const events: string[] = []

class OrderedPart extends PluginPart<Provider> {
	protected override init() {
		events.push('part:init')
	}
}

@Plugin()
class Provider extends BasePlugin {
	readonly part = this.parts.use(OrderedPart)

	override init() {
		events.push('plugin:init')
	}
}

@Plugin()
class Required extends BasePlugin {
	constructor(readonly provider: Provider) {
		super()
	}
}

const ProviderRef = definePluginRef<Provider>()
let optionalStarts: number
let optionalCleanups: number

@Plugin()
class Optional extends BasePlugin {
	connected = false

	override init() {
		optionalStarts++
		this.plugins.use(ProviderRef, () => {
			this.connected = true
			return () => {
				optionalCleanups++
			}
		})
	}
}

@Plugin()
class Peer extends BasePlugin {}

it('finalizes after author init and publishes before watchers and summary consumers', async () => {
	events.length = 0
	let prepared: CoreCommitPublication | undefined
	let operation: CoreCommitPublication['operation'] | undefined
	const publications: CoreCommitPublication[] = []
	await using host = hostWithHooks({
		finalizeGeneration: (generation) => {
			expect(host.isRunning(Provider)).toBe(false)
			operation = generation.operation
			events.push('finalize')
		},
		prepareCommit: async (fact) => {
			await Promise.resolve()
			prepared = fact
			events.push('prepare')
		},
		publishCommit: (fact) => {
			expect(fact).toBe(prepared)
			publications.push(fact)
			events.push('publish')
			return undefined
		},
	})
	const registry = host.pluginService
	host.ctx.effects.defer(
		registry.watchInstance(Provider.nodeAddress(), (instance) => {
			if (instance) events.push('watch')
		}),
	)
	host.ctx.effects.defer(registry.subscribeCommitted(() => events.push('summary')))

	const instance = await host.start(Provider)
	expect(events).toEqual([
		'part:init',
		'plugin:init',
		'finalize',
		'prepare',
		'publish',
		'watch',
		'summary',
	])
	expect(publications[0]?.operation).toBe(operation)
	expect(publications[0]?.started).toEqual([instance.ctx])
	expect(Object.isFrozen(publications[0])).toBe(true)

	host.remove(Provider)
	await host.commit()
	expect(publications[1]).toMatchObject({ started: [], stopped: [instance.ctx], failed: [] })
	await host.commit()
	expect(publications[2]).toMatchObject({ started: [], stopped: [], failed: [] })
})

it('drains a generation rejected by the host finalizer and blocks its required consumer', async () => {
	const cleanup = vi.fn()
	await using host = hostWithHooks({
		finalizeGeneration: ({ ctx }) => {
			ctx.effects.defer(cleanup)
			throw new Error('finalization failed')
		},
	})
	host.add([Required, Provider])
	const summary = await host.commitAllowFail()

	assertPluginLifecycleIssue(summary, Provider, {
		kind: 'start-failed',
		message: 'finalization failed',
	})
	assertPluginLifecycleIssue(summary, Required, {
		kind: 'dependency-blocked',
		blockedBy: Provider,
	})
	expect(host.get(Provider)).toBeUndefined()
	expect(cleanup).toHaveBeenCalledOnce()
})

it('aborts a timed-out host finalizer without publishing a running generation', async () => {
	const release = Promise.withResolvers<void>()
	let signal: AbortSignal | undefined
	const started = vi.fn()
	await using host = hostWithHooks(
		{
			finalizeGeneration: ({ signal: active }) => {
				signal = active
				return release.promise
			},
			publishCommit: (fact) => {
				started(fact.started)
				return undefined
			},
		},
		{ startTimeoutMs: 20, drainTimeoutMs: 20 },
	)

	host.add(Peer)
	try {
		const failed = await host.commitAllowFail()
		assertPluginLifecycleIssue(failed, Peer, { kind: 'start-failed', message: 'start timeout' })
		expect(signal?.aborted).toBe(true)
		expect(started).toHaveBeenCalledExactlyOnceWith([])
		expect(host.get(Peer)).toBeUndefined()
	} finally {
		release.resolve()
	}
})

it('settles in canonical order even when parallel finalizers finish in reverse', async () => {
	const peerFinalized = Promise.withResolvers<void>()
	const finished: string[] = []
	const settle = vi.fn()
	await using host = hostWithHooks(
		{
			finalizeGeneration: async ({ ctx }) => {
				const name = ctx.pluginInfo.nodeAddress.definition.exportName
				if (name === 'Peer') await peerFinalized.promise
				finished.push(name)
				if (name === 'Provider') peerFinalized.resolve()
			},
			settleGenerations: ({ started }) => {
				settle(started.map((ctx) => ctx.pluginInfo.nodeAddress.definition.exportName))
			},
		},
		{ startConcurrency: 2 },
	)

	host.add([Provider, Peer])
	await host.commit()
	expect(finished).toEqual(['Provider', 'Peer'])
	expect(settle).toHaveBeenCalledExactlyOnceWith(['Peer', 'Provider'])
})

it('withdraws a provider rejected by host settlement and republishes its optional consumer', async () => {
	optionalCleanups = 0
	optionalStarts = 0
	let publication: CoreCommitPublication | undefined
	await using host = hostWithHooks({
		settleGenerations: ({ started }) => {
			const provider = started.find(
				(ctx) => ctx.pluginInfo.nodeAddress.definition.exportName === 'Provider',
			)
			return provider ? [{ ctx: provider, error: new Error('route collision') }] : undefined
		},
		publishCommit: (fact) => {
			publication = fact
			return undefined
		},
	})

	host.add([Optional, Required, Provider])
	const summary = await host.commitAllowFail()
	assertPluginLifecycleIssue(summary, Provider, {
		kind: 'start-failed',
		message: 'route collision',
	})
	assertPluginLifecycleIssue(summary, Required, {
		kind: 'dependency-blocked',
		blockedBy: Provider,
	})
	expect(host.get(Provider)).toBeUndefined()
	expect(host.get(Required)).toBeUndefined()
	expect(optionalStarts).toBe(2)
	expect(optionalCleanups).toBe(1)
	const optional = host.require(Optional)
	expect(optional.connected).toBe(false)
	expect(publication?.started).toEqual([optional.ctx])
	expect(publication?.failed).toHaveLength(2)
})

it('runs a queued update after the publishing operation and uses a fresh operation identity', async () => {
	const publications: CoreCommitPublication[] = []
	let queued: Promise<unknown> | undefined
	let reentrantError: unknown
	await using host = hostWithHooks({
		publishCommit: (fact) => {
			publications.push(fact)
			if (publications.length === 1) {
				try {
					host.pluginService.beginUpdate()
				} catch (error) {
					reentrantError = error
				}
				queued = host.pluginService.afterCurrentCommit(async () => {
					host.restart(Peer)
					await host.commit()
				})
			}
			return undefined
		},
	})

	host.add(Peer)
	await host.commit()
	await queued
	expect(reentrantError).toMatchObject({
		message: expect.stringMatching(/another update is active/i),
	})
	expect(publications.map((fact) => fact.operation.revision)).toEqual([1, 2])
	expect(publications[1]?.stopped).toEqual(publications[0]?.started)
	expect(publications[1]?.started).toEqual([host.require(Peer).ctx])
})

it.each(['prepare', 'publish', 'async publish'] as const)(
	'keeps a failed %s out of watchers and permanently rejects further commits',
	async (step) => {
		const failure = new Error('publication failed')
		const publish = vi.fn(() => {
			if (step === 'publish') throw failure
			if (step === 'async publish') return Promise.resolve()
			return undefined
		})
		const host = hostWithHooks({
			prepareCommit: async () => {
				if (step === 'prepare') throw failure
			},
			publishCommit: publish as NonNullable<CorePluginLifecycleHooks['publishCommit']>,
		})
		try {
			const registry = host.pluginService
			const summary = vi.fn()
			const watch = vi.fn()
			host.ctx.effects.defer(registry.subscribeCommitted(summary))
			host.ctx.effects.defer(registry.watchInstance(Peer.nodeAddress(), watch))
			host.add(Peer)

			const rejection = await host.commit().catch((error: unknown) => error)
			expect(rejection).toBeInstanceOf(Error)
			expect(rejection === failure).toBe(step !== 'async publish')
			expect((rejection as Error).message).toMatch(
				step === 'async publish' ? /publication must be synchronous/ : failure.message,
			)
			expect(publish).toHaveBeenCalledTimes(step === 'prepare' ? 0 : 1)
			expect(registry.lastCommit).toBeUndefined()
			expect(summary).not.toHaveBeenCalled()
			expect(watch).toHaveBeenCalledExactlyOnceWith(undefined)
			expect(() => registry.beginUpdate()).toThrow(/host commit publication failed/i)
		} finally {
			await host.ctx.effects.dispose()
		}
	},
)
