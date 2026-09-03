import { pluginDefinitionAddressOf, pluginDefinitionIndexKey } from '@pluxel/core'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import {
	BasePlugin,
	createLocalRpcClient,
	createRuntimeTestHost,
	definePluginFork,
	Plugin,
} from '@pluxel/runtime/test'
import { RpcTarget } from '@pluxel/runtime/capnweb'
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

class BorrowedTarget extends RpcTarget {
	readonly dispose = vi.fn()

	echo(value: Readonly<{ nested: { count: number } }>) {
		return value
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}

describe('runtime testing v2 host', () => {
	it('creates a synchronous public fixture without root authority', async () => {
		const host = createRuntimeTestHost()
		try {
			expect('ctx' in host).toBe(false)
			expect(host[Symbol.asyncDispose]).toBeTypeOf('function')
			expect(host.http.origin).toBe('http://local.test')
		} finally {
			await host.dispose()
		}
	})

	it('keeps optional Workbench and Vault disabled by default', async () => {
		const host = createRuntimeInternalTestHost()
		try {
			expect(host.ctx.workbench).toBeUndefined()
			expect(host.ctx.vault).toBeUndefined()
			expect(host.ctx.vaultAdmin).toBeUndefined()
		} finally {
			await host.dispose()
		}
	})

	it('starts a typed root and its real required dependency in one immediate operation', async () => {
		const host = createRuntimeTestHost()
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
		const host = createRuntimeInternalTestHost()
		try {
			const first = await host.start(PublicFixture)
			expect(host.runtimeStateStore.snapshot().autoStart).toEqual([])
			await host.stop(PublicFixture)
			expect(host.isRunning(PublicFixture)).toBe(false)
			const second = await host.start(PublicFixture)
			expect(second).not.toBe(first)
			const third = await host.restart(PublicFixture)
			expect(third).not.toBe(second)
			expect(host.runtimeStateStore.snapshot().autoStart).toEqual([])
		} finally {
			await host.dispose()
		}
	})

	it('rejects an implicit catalog change on an already-running high-frequency start', async () => {
		const host = createRuntimeInternalTestHost()
		try {
			await host.start(PublicFixture)
			await expect(
				host.start(PublicFixture, { catalog: [SupportingFixture] }),
			).rejects.toThrow(/already-running.*host\.commit/i)
			const key = pluginDefinitionIndexKey(
				host.coordinator.catalogSnapshot().entries[0]!.address,
			)
			expect(
				host.coordinator
					.catalogSnapshot()
					.byDefinition.has(
						pluginDefinitionIndexKey(pluginDefinitionAddressOf(SupportingFixture)),
					),
			).toBe(false)
			expect(host.coordinator.catalogSnapshot().byDefinition.has(key)).toBe(true)
			expect(host.coordinator.catalogSnapshot().entries).toHaveLength(1)
		} finally {
			await host.dispose()
		}
	})

	it('enforces synchronous callback-scoped drafts', async () => {
		const host = createRuntimeTestHost()
		let escaped: Parameters<Parameters<typeof host.commit>[0]>[0] | undefined
		try {
			await expect(host.commit(() => undefined)).rejects.toThrow(/at least one change/i)
			await expect(
				host.commit((async (change) => {
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
		const host = createRuntimeTestHost()
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
		const host = createRuntimeTestHost()
		try {
			await host.start(ReplacementV1)
			await host.replaceDefinition(ReplacementV1, ReplacementV2)
			expect(host.require(ReplacementV2).version).toBe(2)
			expect(() => host.isRunning(ReplacementV1)).toThrow(/stale/i)
		} finally {
			await host.dispose()
		}
	})

	it('shares concurrent disposal settlement and rejects later operations', async () => {
		const host = createRuntimeTestHost()
		const first = host.dispose()
		const second = host.dispose()
		expect(second).toBe(first)
		await first
		await expect(host.start(PublicFixture)).rejects.toThrow(/closing or closed/i)
	})
})

describe('local RPC ownership', () => {
	it('borrows the root target while preserving local membrane copies', async () => {
		const target = new BorrowedTarget()
		const client = createLocalRpcClient(target)
		const input = { nested: { count: 1 } }
		const output = await client.echo(input)
		expect(output).toEqual(input)
		expect(output).not.toBe(input)
		client[Symbol.dispose]()
		expect(target.dispose).not.toHaveBeenCalled()
		target[Symbol.dispose]()
		expect(target.dispose).toHaveBeenCalledOnce()
	})
})
