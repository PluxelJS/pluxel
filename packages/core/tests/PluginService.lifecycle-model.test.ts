import assert from 'node:assert/strict'
import {
	BasePlugin,
	Plugin,
	definePluginRef,
	withCoreInternalTestHost,
	type CoreInternalTestHost,
} from '@pluxel/core/internal/test'
import { CorePluginGraphVerificationError, requirePluginService } from '@pluxel/core/internal'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lowerTestReplacement } from './lowered-replacement'

type NodeName = 'provider' | 'required' | 'optional' | 'independent'
type EffectName = NodeName | 'optional-integration'

type Counters = {
	constructed: number
	started: number
	cleaned: number
	active: number
}

const counters: Record<EffectName, Counters> = {
	provider: createCounters(),
	required: createCounters(),
	optional: createCounters(),
	independent: createCounters(),
	'optional-integration': createCounters(),
}

let providerShouldFail = false
const optionalProviderGenerations: number[] = []

function createCounters(): Counters {
	return { constructed: 0, started: 0, cleaned: 0, active: 0 }
}

function resetLifecycleModelState(): void {
	for (const value of Object.values(counters)) {
		value.constructed = 0
		value.started = 0
		value.cleaned = 0
		value.active = 0
	}
	providerShouldFail = false
	optionalProviderGenerations.length = 0
}

function nextGeneration(name: NodeName): number {
	return ++counters[name].constructed
}

function ownEffect(name: EffectName): () => void {
	const counter = counters[name]
	counter.started++
	counter.active++
	let disposed = false
	return () => {
		if (disposed) throw new Error(`${name} cleanup ran more than once`)
		disposed = true
		counter.cleaned++
		counter.active--
	}
}

@Plugin({ displayName: 'Lifecycle model provider' })
class LifecycleModelProvider extends BasePlugin {
	readonly generation = nextGeneration('provider')

	override init(): void {
		this.ctx.effects.defer(ownEffect('provider'))
		if (providerShouldFail) throw new Error('model provider failed')
	}
}

const LifecycleModelProviderRef = definePluginRef<LifecycleModelProvider>()

class LifecycleModelProviderReplacement extends LifecycleModelProvider {}

@Plugin({ displayName: 'Lifecycle model required consumer' })
class LifecycleModelRequiredConsumer extends BasePlugin {
	readonly generation = nextGeneration('required')

	constructor(readonly provider: LifecycleModelProvider) {
		super()
	}

	override init(): void {
		this.ctx.effects.defer(ownEffect('required'))
	}
}

@Plugin({ displayName: 'Lifecycle model optional consumer' })
class LifecycleModelOptionalConsumer extends BasePlugin {
	readonly generation = nextGeneration('optional')

	override init(): void {
		this.ctx.effects.defer(ownEffect('optional'))
		this.plugins.use(LifecycleModelProviderRef, (provider) => {
			optionalProviderGenerations.push(provider.generation)
			return ownEffect('optional-integration')
		})
	}
}

@Plugin({ displayName: 'Lifecycle model independent' })
class LifecycleModelIndependent extends BasePlugin {
	readonly generation = nextGeneration('independent')

	override init(): void {
		this.ctx.effects.defer(ownEffect('independent'))
	}
}

const nodes = {
	provider: LifecycleModelProvider,
	required: LifecycleModelRequiredConsumer,
	optional: LifecycleModelOptionalConsumer,
	independent: LifecycleModelIndependent,
}

const addBatches = [
	[['provider', 'required', 'optional', 'independent']],
	[['independent', 'optional', 'required', 'provider']],
	[['required', 'provider', 'independent'], ['optional']],
	[['optional'], ['independent', 'provider'], ['required']],
	[['provider'], ['required'], ['independent'], ['optional']],
	[['independent'], ['provider'], ['optional'], ['required']],
] as const

describe('PluginService lifecycle model traces', () => {
	beforeAll(() => {
		lowerTestReplacement(LifecycleModelProvider, LifecycleModelProviderReplacement, {
			plugin: { displayName: 'Lifecycle model provider replacement' },
		})
	})
	beforeEach(resetLifecycleModelState)

	it('converges to the same running projection across batched and incremental add orders', async () => {
		for (const batches of addBatches) {
			resetLifecycleModelState()
			const trace = batches.map((batch) => batch.join(',')).join(' → ')
			await withCoreInternalTestHost(async (host) => {
				const installed = new Set<NodeName>()
				for (const batch of batches) {
					batch.forEach((node) => installed.add(node))
					host.add(batch.map((node) => nodes[node]))
					await host.commit()
					const label = `${trace} after ${[...installed].join(',')}`
					assertLifecycleInvariants(host, label)
					assert.deepEqual(readRunningProjection(host), installed, label)
				}
			})
		}
	})

	it('keeps failure recovery local and restarts optional consumers only on real availability changes', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add([nodes.optional, nodes.independent])
			await host.commit()
			const initiallyAbsent = host.require(nodes.optional)
			assertLifecycleInvariants(host, 'optional consumer before provider admission')

			providerShouldFail = true
			host.add(nodes.provider)
			await host.commitAllowFail()
			expect(host.require(nodes.optional)).toBe(initiallyAbsent)
			await host.commitAllowFail()
			host.add(nodes.required)
			await host.commitAllowFail()
			expect(host.require(nodes.optional)).toBe(initiallyAbsent)
			expect(counters.optional.constructed).toBe(1)
			expect(readRunningProjection(host)).toEqual(new Set(['optional', 'independent']))
			assertLifecycleInvariants(host, 'failed provider and blocked required consumer')

			providerShouldFail = false
			await host.commit()
			expect(readRunningProjection(host)).toEqual(new Set(Object.keys(nodes)))
			expect(host.require(nodes.optional).generation).toBe(2)
			assertLifecycleInvariants(host, 'provider recovered')

			host.restart(nodes.provider)
			const restarted = await host.commit()
			expect(restarted.pluginChanges.restarted).toHaveLength(3)
			expect(restarted.pluginChanges.restarted).toEqual(
				expect.arrayContaining([
					registry.resolvePluginNode(nodes.provider),
					registry.resolvePluginNode(nodes.required),
					registry.resolvePluginNode(nodes.optional),
				]),
			)
			expect(host.require(nodes.optional).generation).toBe(3)
			assertLifecycleInvariants(host, 'provider restarted')

			providerShouldFail = true
			host.restart(nodes.provider)
			await host.commitAllowFail()
			const nowAbsent = host.require(nodes.optional)
			expect(nowAbsent.generation).toBe(4)
			expect(readRunningProjection(host)).toEqual(new Set(['optional', 'independent']))
			await host.commitAllowFail()
			expect(host.require(nodes.optional)).toBe(nowAbsent)
			expect(optionalProviderGenerations).toHaveLength(2)
			assertLifecycleInvariants(host, 'provider failed again')

			providerShouldFail = false
			await host.commit()
			expect(host.require(nodes.optional).generation).toBe(5)
			expect(readRunningProjection(host)).toEqual(new Set(Object.keys(nodes)))
			assertLifecycleInvariants(host, 'provider recovered again')

			host.remove(nodes.provider)
			await host.commit()
			expect(host.require(nodes.optional).generation).toBe(6)
			expect(readRunningProjection(host)).toEqual(new Set(['optional', 'independent']))
			expect(counters.optional.cleaned).toBe(5)
			expect(counters['optional-integration'].cleaned).toBe(3)
			assertLifecycleInvariants(host, 'provider removed')
		})

		expect(counters.independent.constructed).toBe(1)
		expect(optionalProviderGenerations).toHaveLength(3)
		expect(optionalProviderGenerations).toEqual(
			[...optionalProviderGenerations].sort((a, b) => a - b),
		)
	})

	it('replaces a provider without leaking the old provider generation or double restarting consumers', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add(Object.values(nodes))
			await host.commit()
			assertLifecycleInvariants(host, 'original definition')

			host.replace(nodes.provider, LifecycleModelProviderReplacement)
			const replacement = await host.commit()
			expect(replacement.pluginChanges.restarted).toHaveLength(2)
			expect(replacement.pluginChanges.restarted).toEqual(
				expect.arrayContaining([
					registry.resolvePluginNode(nodes.required),
					registry.resolvePluginNode(nodes.optional),
				]),
			)
			expect(host.require(nodes.required).generation).toBe(2)
			expect(host.require(nodes.optional).generation).toBe(2)
			expect(readRunningProjection(host)).toEqual(new Set(Object.keys(nodes)))
			assertLifecycleInvariants(host, 'replacement definition')
		})

		for (const [name, count] of Object.entries(counters)) {
			expect(count.active, `${name} active effects after disposal`).toBe(0)
			expect(count.cleaned, `${name} cleanup count after disposal`).toBe(count.started)
		}
		expect(counters.provider.started).toBe(2)
		expect(optionalProviderGenerations).toEqual([1, 2])
	})

	it('keeps the committed graph when a non-cascading removal leaves a missing dependency', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([nodes.provider, nodes.required])
			await host.commit()
			host.remove(nodes.provider, { cascadeDependents: false })
			const error = await Promise.resolve()
				.then(() => host.commit())
				.catch((cause: unknown) => cause)
			expect(error).toBeInstanceOf(CorePluginGraphVerificationError)
			if (!(error instanceof CorePluginGraphVerificationError)) throw error
			expect(error.message).toMatch(/Core Plugin graph verification failed/)
			expect(error.issues).toBe(error.cause.issues)
			expect(error.issues).toContainEqual(expect.objectContaining({ kind: 'MissingDependency' }))
			expect(readRunningProjection(host)).toEqual(new Set(['provider', 'required']))
			assertLifecycleInvariants(host, 'rejected non-cascading removal')
		})
	})
})

function assertLifecycleInvariants(host: CoreInternalTestHost, label: string): void {
	const running = readRunningProjection(host)

	for (const name of ['provider', 'required', 'optional', 'independent'] as const) {
		const expectedActive = running.has(name) ? 1 : 0
		expect(counters[name].active, `${label}: ${name} active effects`).toBe(expectedActive)
		expect(
			counters[name].cleaned <= counters[name].started,
			`${label}: ${name} cleanup count`,
		).toBe(true)
	}

	const optionalIntegrationActive = running.has('provider') && running.has('optional') ? 1 : 0
	expect(
		counters['optional-integration'].active,
		`${label}: optional integration active effects`,
	).toBe(optionalIntegrationActive)
	expect(
		counters['optional-integration'].cleaned <= counters['optional-integration'].started,
		`${label}: optional integration cleanup count`,
	).toBe(true)

	if (running.has('required')) {
		assert(running.has('provider'), `${label}: required consumer has running provider`)
		assert.equal(
			host.require(LifecycleModelRequiredConsumer).provider.generation,
			host.require(LifecycleModelProvider).generation,
			`${label}: required consumer uses the running provider generation`,
		)
	}

	if (host.isRunning(LifecycleModelIndependent)) {
		assert.equal(
			host.require(LifecycleModelIndependent).generation,
			1,
			`${label}: independent generation`,
		)
	}
}

function readRunningProjection(host: CoreInternalTestHost): Set<NodeName> {
	const running = new Set<NodeName>()
	for (const name of ['provider', 'required', 'optional', 'independent'] as const)
		if (host.isRunning(nodes[name])) running.add(name)
	return running
}
