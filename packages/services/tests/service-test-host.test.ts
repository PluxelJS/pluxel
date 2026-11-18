import type { WorkbenchHost } from '@pluxel/workbench/server'
import { Commands } from '@pluxel/services/commands'
import { ElysiaApp, elysia } from '@pluxel/services/elysia'
import {
	pluginDefinitionIndexKey,
	parsePluginNodeAddress,
	BasePlugin,
	Plugin,
	defineServiceRef,
} from '@pluxel/core'
import { createPluginControlReference } from '@pluxel/host/internal/control-reference'
import { createServiceInternalTestHost } from '@pluxel/services/internal/test'
import { createTestHost } from '@pluxel/test'
import { lowerTestReplacement } from '@pluxel/test/unsafe'
import { describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { requireHostDocuments, requireVaultHost } from '@pluxel/core/internal'

const WorkbenchHostRef = defineServiceRef<WorkbenchHost>()
@Plugin({ displayName: 'Public test host fixture' })
class PublicFixture extends BasePlugin {}

@Plugin({ displayName: 'HTTP-only test composition' })
class HttpOnlyFixture extends BasePlugin {
	protected override init(): void {
		this.ctx.service(ElysiaApp).get('/test-composition', () => 'http-only')
	}
}

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

@Plugin()
class ForkConsumer extends BasePlugin {
	constructor(readonly dependency: ForkableFixture) {
		super()
	}
}

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

const SeedConfig = v.object({
	text: v.pipe(
		v.string(),
		v.transform((value) => value.trim()),
	),
	fallback: v.optional(v.string(), 'default'),
})
@Plugin()
class SeedFixture extends BasePlugin {
	readonly config = this.configs.use(SeedConfig)
}

describe('service test host', () => {
	it('injects read-only Vault records through the public test host with Plugin node isolation', async () => {
		await using host = await createTestHost({
			coreConfig: { vault: { backend: 'bindings' } },
			vaultBindings: [
				{
					owner: ForkableFixture.nodeAddress(),
					key: 'primary',
					value: { token: 'test-token' },
					source: 'env',
				},
			],
		})
		const [owner, fork] = await host.start([
			ForkableFixture.nodeAddress(),
			ForkableFixture.nodeAddress('east'),
		])
		expect(await owner.ctx.vault.kv().get('primary')).toMatchObject({
			exists: true,
			value: { token: 'test-token' },
			source: 'env',
			writable: false,
		})
		expect(await fork.ctx.vault.kv().get('primary')).toMatchObject({ exists: false })
		await expect(owner.ctx.vault.kv().set('primary', {})).rejects.toMatchObject({
			code: 'READ_ONLY',
		})
	})

	it('requires source implementation evidence rather than generated or portable addresses', async () => {
		await using host = await createTestHost()
		const source = ForkableFixture.nodeAddress('east')
		const generated = createPluginControlReference({
			format: 2,
			definition: ForkableFixture.address(),
			contracts: { config: null, instance: `sha256:${'a'.repeat(64)}` },
		})
		for (const target of [
			generated.nodeAddress(),
			generated.nodeAddress('east'),
			parsePluginNodeAddress(source),
			JSON.parse(JSON.stringify(source)),
		]) {
			await expect(host.start(target as never)).rejects.toThrow(
				/original concrete Plugin class nodeAddress/,
			)
		}
		expect(host.isRunning(source)).toBe(false)
		const instance = await host.start(source)
		expect(instance.constructor).toBe(ForkableFixture)
	})

	it('accepts repeated equal fork overrides while rejecting different implementation evidence', async () => {
		await using host = await createTestHost()
		await host.commit((change) => {
			change.start([
				ForkableFixture.nodeAddress(),
				ForkableFixture.nodeAddress('east'),
				ForkConsumer.nodeAddress(),
			])
			for (let index = 0; index < 2; index++) {
				change.dependencies.setOverride({
					consumer: ForkConsumer.nodeAddress(),
					requirement: ForkableFixture,
					provider: ForkableFixture.nodeAddress('east'),
				})
			}
		})
		expect(host.require(ForkConsumer.nodeAddress()).dependency.ctx.pluginInfo.nodeAddress).toEqual(
			parsePluginNodeAddress(ForkableFixture.nodeAddress('east')),
		)
		class Replacement extends ForkableFixture {}
		lowerTestReplacement(ForkableFixture, Replacement, { plugin: { forkable: true } })
		await expect(
			host.commit((change) => {
				change.dependencies.setOverride({
					consumer: ForkConsumer.nodeAddress(),
					requirement: ForkableFixture,
					provider: ForkableFixture.nodeAddress('east'),
				})
				change.dependencies.setOverride({
					consumer: ForkConsumer.nodeAddress(),
					requirement: ForkableFixture,
					provider: Replacement.nodeAddress('east'),
				})
			}),
		).rejects.toThrow(/Conflicting dependencies.setOverride/)
	})

	it('persists initialConfig as raw input while publishing normalized config and schema defaults', async () => {
		await using host = await createServiceInternalTestHost({ services: [] })
		const instance = await host.start(SeedFixture.nodeAddress(), {
			initialConfig: { text: ' seeded ' },
		})
		expect(instance.config).toEqual({ text: 'seeded', fallback: 'default' })
		const saved = await requireHostDocuments(host.ctx, 'config').getText('config.json')
		expect(JSON.parse(saved!).json).toMatchObject({
			plugins: [{ owner: SeedFixture.nodeAddress(), config: { text: ' seeded ' } }],
		})
	})

	it('uses the explicit service list without adding default services', async () => {
		await using bare = await createTestHost({ services: [] })
		await bare.start(PublicFixture.nodeAddress())
		expect(bare.isRunning(PublicFixture.nodeAddress())).toBe(true)
		expect(() => bare.commands.list()).toThrow(/commands/i)

		await using httpOnly = await createTestHost({ services: [elysia()] })
		await httpOnly.start(HttpOnlyFixture.nodeAddress())
		const response = await httpOnly.http.fetch(new URL('/test-composition', httpOnly.http.origin))
		expect(await response.text()).toBe('http-only')
		expect(() => httpOnly.commands.list()).toThrow(/commands/i)
	})

	it('keeps Workbench optional and Vault built in without initializing credentials', async () => {
		await using host = await createServiceInternalTestHost()

		expect(host.ctx.service(WorkbenchHostRef)).toBeUndefined()
		const owner = await host.start(PublicFixture.nodeAddress())
		expect(owner.ctx.vault).toBe(owner.ctx.vault)
		expect(await requireVaultHost(host.ctx).admin.describe()).toMatchObject({
			present: false,
			unlocked: false,
			hostIdentityPresent: false,
		})
	})

	it('starts a typed dependency closure without exposing root authority', async () => {
		await using host = await createTestHost()
		expect('ctx' in host).toBe(false)
		expect(host[Symbol.asyncDispose]).toBeTypeOf('function')
		expect(host.http.origin).toBe('http://local.test')

		const consumer = await host.start(DependencyConsumer.nodeAddress(), {
			catalog: [RequiredDependency],
		})
		expect(consumer).toBeInstanceOf(DependencyConsumer)
		expect(consumer.dependency).toBeInstanceOf(RequiredDependency)
		expect(host.require(DependencyConsumer.nodeAddress())).toBe(consumer)
		expect(host.isRunning(RequiredDependency.nodeAddress())).toBe(true)
	})

	it('stops and restarts immediately without changing durable auto-start policy', async () => {
		await using host = await createServiceInternalTestHost()

		const first = await host.start(PublicFixture.nodeAddress())
		expect(host.stateStore.snapshot().autoStart).toEqual([])
		await host.stop(PublicFixture.nodeAddress())
		expect(host.isRunning(PublicFixture.nodeAddress())).toBe(false)
		const second = await host.start(PublicFixture.nodeAddress())
		expect(second).not.toBe(first)
		const third = await host.restart(PublicFixture.nodeAddress())
		expect(third).not.toBe(second)
		expect(host.stateStore.snapshot().autoStart).toEqual([])
	})

	it('rejects an implicit catalog change on an already-running high-frequency start', async () => {
		await using host = await createServiceInternalTestHost()

		await host.start(PublicFixture.nodeAddress())
		await expect(
			host.start(PublicFixture.nodeAddress(), { catalog: [SupportingFixture] }),
		).rejects.toThrow(/already-running.*host\.commit/i)
		const key = pluginDefinitionIndexKey(host.coordinator.catalogSnapshot().entries[0]!.address)
		expect(
			host.coordinator
				.catalogSnapshot()
				.byDefinition.has(pluginDefinitionIndexKey(SupportingFixture.address())),
		).toBe(false)
		expect(host.coordinator.catalogSnapshot().byDefinition.has(key)).toBe(true)
		expect(host.coordinator.catalogSnapshot().entries).toHaveLength(1)
	})

	it('enforces synchronous callback-scoped drafts', async () => {
		await using host = await createTestHost()
		let escaped: Parameters<Parameters<typeof host.commit>[0]>[0] | undefined

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
		expect(() => escaped!.stop(PublicFixture.nodeAddress())).toThrow(/cannot escape/i)
	})

	it('requires durable fork removal to be the only callback command', async () => {
		await using host = await createTestHost()
		const fork = ForkableFixture.nodeAddress('east')

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
	})

	it('commits definition-wide replacement and stale-rejects the old constructor', async () => {
		const ReplacementV2 = lowerTestReplacement(
			ReplacementV1,
			class extends ReplacementV1 {
				override readonly version: number = 2
			},
			{ plugin: { displayName: 'Replacement v2' } },
		)
		await using host = await createTestHost()

		await host.start(ReplacementV1.nodeAddress())
		await host.replaceDefinition(ReplacementV1, ReplacementV2)
		expect(host.require(ReplacementV2.nodeAddress()).version).toBe(2)
		expect(() => host.isRunning(ReplacementV1.nodeAddress())).toThrow(/stale/i)
	})

	it('drains an expected lifecycle failure and accepts the next operation after its requested intent is cleared', async () => {
		await using host = await createTestHost()
		rollbackCleanup.mockClear()

		const failure = await host.commitExpectFail((change) =>
			change.start(RollbackFixture.nodeAddress()),
		)

		expect(failure.lifecycleReport.issues).toHaveLength(1)
		expect(failure.lifecycleReport.issues[0]).toMatchObject({
			kind: 'start-failed',
			message: 'expected public host rollback',
		})
		expect(rollbackCleanup).toHaveBeenCalledOnce()
		expect(host.isRunning(RollbackFixture.nodeAddress())).toBe(false)

		await host.stop(RollbackFixture.nodeAddress())
		await host.start(PublicFixture.nodeAddress())
		expect(host.isRunning(PublicFixture.nodeAddress())).toBe(true)
	})

	it('shares concurrent disposal settlement and rejects later operations', async () => {
		const host = await createTestHost()
		const first = host.dispose()
		const second = host.dispose()
		expect(second).toBe(first)
		await expect(host.start(PublicFixture.nodeAddress())).rejects.toThrow(/closing or closed/i)
		await expect(host.http.fetch('/probe')).rejects.toThrow(/closing or closed/i)
		await first
	})
})

it('uses an explicit service list without silently installing defaults', async () => {
	await using host = await createServiceInternalTestHost({ services: [] })
	expect(() => host.ctx.service(Commands)).toThrow('does not install')
	await host.start(PublicFixture.nodeAddress())
	expect(host.isRunning(PublicFixture.nodeAddress())).toBe(true)
})
