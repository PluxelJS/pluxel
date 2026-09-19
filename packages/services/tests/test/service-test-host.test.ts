import { Commands } from '@pluxel/services/commands'
import { pluginDefinitionAddressOf, pluginDefinitionIndexKey } from '@pluxel/core'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { BasePlugin, definePluginFork, Plugin } from '@pluxel/core/test'
import { createServiceTestHost } from '@pluxel/services/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { describe, expect, it, vi } from 'vitest'

@Plugin({ displayName: 'Public test host fixture' })
class PublicFixture extends BasePlugin {}

@Plugin({ displayName: 'Supporting catalog fixture' })
class SupportingFixture extends BasePlugin {}

@Plugin({ displayName: 'Required dependency' })
class RequiredDependency extends BasePlugin {}

@Plugin({ displayName: 'Dependency consumer' })
class DependencyConsumer extends BasePlugin {
	constructor(readonly dependency: RequiredDependency) {
		super()
	}
}

@Plugin({ displayName: 'Forkable fixture', forkable: true })
class ForkableFixture extends BasePlugin {}

@Plugin({ displayName: 'Replacement v1' })
class ReplacementV1 extends BasePlugin {
	readonly version: number = 1
}

const rollbackCleanup = vi.fn()

@Plugin({ displayName: 'Rollback fixture' })
class RollbackFixture extends BasePlugin {
	protected override init(): void {
		this.ctx.effects.defer(rollbackCleanup)
		throw new Error('expected public host rollback')
	}
}

describe('service test host', () => {
	it('creates a synchronous public fixture without root authority', async () => {
		const host = await createServiceTestHost()
		try {
			expect('ctx' in host).toBe(false)
			expect(host[Symbol.asyncDispose]).toBeTypeOf('function')
			expect(host.http.origin).toBe('http://local.test')
		} finally {
			await host.dispose()
		}
	})

	it('keeps optional Workbench and Vault disabled by default', async () => {
		const host = await createServiceInternalTestHost()
		try {
			expect(host.ctx.workbench).toBeUndefined()
			expect(host.ctx.vault).toBeUndefined()
			expect(host.ctx.vaultAdmin).toBeUndefined()
		} finally {
			await host.dispose()
		}
	})

	it('starts a typed root and its real required dependency in one immediate operation', async () => {
		const host = await createServiceTestHost()
		try {
			const consumer = await host.start(DependencyConsumer, {
				catalog: [RequiredDependency],
			})
			expect(consumer).toBeInstanceOf(DependencyConsumer)
			expect(consumer.dependency).toBeInstanceOf(RequiredDependency)
			expect(host.require(DependencyConsumer)).toBe(consumer)
			expect(host.isRunning(RequiredDependency)).toBe(true)
		} finally {
			await host.dispose()
		}
	})

	it('stops and restarts immediately without changing durable auto-start policy', async () => {
		const host = await createServiceInternalTestHost()
		try {
			const first = await host.start(PublicFixture)
			expect(host.stateStore.snapshot().autoStart).toEqual([])
			await host.stop(PublicFixture)
			expect(host.isRunning(PublicFixture)).toBe(false)
			const second = await host.start(PublicFixture)
			expect(second).not.toBe(first)
			const third = await host.restart(PublicFixture)
			expect(third).not.toBe(second)
			expect(host.stateStore.snapshot().autoStart).toEqual([])
		} finally {
			await host.dispose()
		}
	})

	it('rejects an implicit catalog change on an already-running high-frequency start', async () => {
		const host = await createServiceInternalTestHost()
		try {
			await host.start(PublicFixture)
			await expect(host.start(PublicFixture, { catalog: [SupportingFixture] })).rejects.toThrow(
				/already-running.*host\.commit/i,
			)
			const key = pluginDefinitionIndexKey(host.coordinator.catalogSnapshot().entries[0]!.address)
			expect(
				host.coordinator
					.catalogSnapshot()
					.byDefinition.has(pluginDefinitionIndexKey(pluginDefinitionAddressOf(SupportingFixture))),
			).toBe(false)
			expect(host.coordinator.catalogSnapshot().byDefinition.has(key)).toBe(true)
			expect(host.coordinator.catalogSnapshot().entries).toHaveLength(1)
		} finally {
			await host.dispose()
		}
	})

	it('enforces synchronous callback-scoped drafts', async () => {
		const host = await createServiceTestHost()
		let escaped: Parameters<Parameters<typeof host.commit>[0]>[0] | undefined
		try {
			await expect(host.commit((): undefined => undefined)).rejects.toThrow(/at least one change/i)
			await expect(
				host.commit((async (change: Parameters<Parameters<typeof host.commit>[0]>[0]) => {
					change.catalog.add(PublicFixture)
				}) as never),
			).rejects.toThrow(/synchronous/i)
			await host.commit((change) => {
				escaped = change
				change.catalog.add(PublicFixture)
			})
			expect(() => escaped!.stop(PublicFixture)).toThrow(/cannot escape/i)
		} finally {
			await host.dispose()
		}
	})

	it('requires durable fork removal to be the only callback command', async () => {
		const host = await createServiceTestHost()
		const fork = definePluginFork(ForkableFixture, 'east')
		try {
			await host.start(fork)
			await expect(
				host.commit((change) => {
					change.forks.remove(fork)
					change.catalog.add(SupportingFixture)
				}),
			).rejects.toThrow(/must be the only command/i)
			expect(host.isRunning(fork)).toBe(true)
			await host.commit((change) => change.forks.remove(fork))
			expect(host.isRunning(fork)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('commits definition-wide replacement and stale-rejects the old constructor', async () => {
		const ReplacementV2 = lowerTestReplacement(
			ReplacementV1,
			class extends ReplacementV1 {
				override readonly version: number = 2
			},
			{ plugin: { displayName: 'Replacement v2' } },
		)
		const host = await createServiceTestHost()
		try {
			await host.start(ReplacementV1)
			await host.replaceDefinition(ReplacementV1, ReplacementV2)
			expect(host.require(ReplacementV2).version).toBe(2)
			expect(() => host.isRunning(ReplacementV1)).toThrow(/stale/i)
		} finally {
			await host.dispose()
		}
	})

	it('drains an expected lifecycle failure and accepts the next operation after its requested intent is cleared', async () => {
		const host = await createServiceTestHost()
		rollbackCleanup.mockClear()
		try {
			const failure = await host.commitExpectFail((change) => change.start(RollbackFixture))

			expect(failure.lifecycleReport.issues).toHaveLength(1)
			expect(failure.lifecycleReport.issues[0]).toMatchObject({
				kind: 'start-failed',
				message: 'expected public host rollback',
			})
			expect(rollbackCleanup).toHaveBeenCalledOnce()
			expect(host.isRunning(RollbackFixture)).toBe(false)

			await host.stop(RollbackFixture)
			await host.start(PublicFixture)
			expect(host.isRunning(PublicFixture)).toBe(true)
		} finally {
			await host.dispose()
		}
	})

	it('shares concurrent disposal settlement and rejects later operations', async () => {
		const host = await createServiceTestHost()
		const first = host.dispose()
		const second = host.dispose()
		expect(second).toBe(first)
		await expect(host.start(PublicFixture)).rejects.toThrow(/closing or closed/i)
		await expect(host.http.fetch('/probe')).rejects.toThrow(/closing or closed/i)
		await first
	})
})

it('uses an explicit service list without silently installing defaults', async () => {
	await using host = await createServiceInternalTestHost({ services: [] })
	expect(() => host.ctx.require(Commands)).toThrow('does not install')
	await host.start(PublicFixture)
	expect(host.isRunning(PublicFixture)).toBe(true)
})
