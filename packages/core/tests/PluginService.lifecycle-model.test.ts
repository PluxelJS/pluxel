import { BasePlugin, Plugin, definePluginRef, withCoreHost, type CoreHost } from '@pluxel/core/test'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
let queuedInitStarted: Promise<void>
let markQueuedInitStarted: () => void
let queuedInitRelease: Promise<void>
let releaseQueuedInit: () => void
const queuedCommitEvents: string[] = []
const reentrantCleanupOrder: string[] = []
let lateInitPromise: Promise<void>
let resolveLateInit: () => void
let lateCleanupRuns = 0

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
	queuedCommitEvents.length = 0
	reentrantCleanupOrder.length = 0
	lateCleanupRuns = 0
	;({ promise: queuedInitStarted, resolve: markQueuedInitStarted } = Promise.withResolvers<void>())
	;({ promise: queuedInitRelease, resolve: releaseQueuedInit } = Promise.withResolvers<void>())
	;({ promise: lateInitPromise, resolve: resolveLateInit } = Promise.withResolvers<void>())
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

@Plugin({ displayName: 'Lifecycle model queued provider' })
class LifecycleModelQueuedProvider extends BasePlugin {
	readonly generation = nextGeneration('provider')

	override async init(): Promise<void> {
		queuedCommitEvents.push(`provider:start:${this.generation}`)
		markQueuedInitStarted()
		await queuedInitRelease
		this.ctx.effects.defer(() => {
			queuedCommitEvents.push(`provider:cleanup:${this.generation}`)
		})
	}
}

@Plugin({ displayName: 'Lifecycle model queued consumer' })
class LifecycleModelQueuedConsumer extends BasePlugin {
	constructor(readonly provider: LifecycleModelQueuedProvider) {
		super()
	}

	override init(): () => void {
		queuedCommitEvents.push(`consumer:start:${this.provider.generation}`)
		return () => {
			queuedCommitEvents.push(`consumer:cleanup:${this.provider.generation}`)
		}
	}
}

@Plugin({ displayName: 'Lifecycle model reentrant cleanup' })
class LifecycleModelReentrantCleanup extends BasePlugin {
	override init(): void {
		this.ctx.effects.defer(() => {
			reentrantCleanupOrder.push('outer')
			this.ctx.effects.defer(() => {
				reentrantCleanupOrder.push('inner')
			})
		})
	}
}

@Plugin({ displayName: 'Lifecycle model late init', startTimeoutMs: 15 })
class LifecycleModelLateInit extends BasePlugin {
	override async init(): Promise<() => void> {
		await lateInitPromise
		return () => {
			lateCleanupRuns++
		}
	}
}

type Action =
	| 'add-provider'
	| 'add-required'
	| 'add-optional'
	| 'add-independent'
	| 'commit'
	| 'commit-allow-fail'
	| 'fail-provider'
	| 'recover-provider'
	| 'restart-provider'
	| 'replace-provider'

type Trace = {
	readonly name: string
	readonly actions: readonly Action[]
	readonly finalRunning: ReadonlySet<NodeName>
}

describe('PluginService lifecycle model traces', () => {
	beforeAll(() => {
		lowerTestReplacement(LifecycleModelProvider, LifecycleModelProviderReplacement, {
			plugin: { displayName: 'Lifecycle model provider replacement' },
		})
	})
	beforeEach(resetLifecycleModelState)

	it('converges to the same running projection across batched and incremental add orders', async () => {
		expect.hasAssertions()
		for (const order of allAddOrders()) {
			await runTrace({
				name: `batched-add-order:${order.join(',')}`,
				actions: [...order, 'commit'],
				finalRunning: new Set(['provider', 'required', 'optional', 'independent']),
			})
		}
		for (const order of legalIncrementalAddOrders()) {
			await runTrace({
				name: `incremental-add-order:${order.join(',')}`,
				actions: interleaveCommits(order),
				finalRunning: new Set(['provider', 'required', 'optional', 'independent']),
			})
		}
	})

	it('keeps failure recovery local and restarts optional consumers only on real availability changes', async () => {
		await runTrace({
			name: 'failure-recovery-with-optional-consumer',
			actions: [
				'add-optional',
				'add-independent',
				'commit',
				'fail-provider',
				'add-provider',
				'commit-allow-fail',
				'commit-allow-fail',
				'add-required',
				'commit-allow-fail',
				'recover-provider',
				'commit',
				'restart-provider',
				'commit',
				'fail-provider',
				'restart-provider',
				'commit-allow-fail',
				'commit-allow-fail',
				'recover-provider',
				'commit',
			],
			finalRunning: new Set(['provider', 'required', 'optional', 'independent']),
		})

		expect(counters.independent.constructed).toBe(1)
		expect(optionalProviderGenerations).toHaveLength(3)
		expect(optionalProviderGenerations).toEqual(
			[...optionalProviderGenerations].sort((a, b) => a - b),
		)
	})

	it('replaces a provider without leaking the old provider generation or double restarting consumers', async () => {
		await runTrace({
			name: 'provider-replacement',
			actions: [
				'add-provider',
				'add-required',
				'add-optional',
				'add-independent',
				'commit',
				'replace-provider',
				'commit',
			],
			finalRunning: new Set(['provider', 'required', 'optional', 'independent']),
		})

		expect(counters.provider.active).toBe(0)
		expect(counters.required.active).toBe(0)
		expect(counters.optional.active).toBe(0)
		expect(counters['optional-integration'].active).toBe(0)
		expect(counters.provider.started).toBe(2)
		expect(counters.provider.cleaned).toBe(2)
		expect(optionalProviderGenerations).toEqual([1, 2])
	})

	it('rejects an overlapping transaction and converges after the active commit', async () => {
		await withCoreHost(async (host) => {
			host.add([LifecycleModelQueuedProvider, LifecycleModelQueuedConsumer])
			const initialCommit = host.commit()
			await queuedInitStarted

			expect(() => host.remove(LifecycleModelQueuedProvider)).toThrow(/another update is active/i)

			releaseQueuedInit()
			await initialCommit
			host.remove(LifecycleModelQueuedProvider)
			await host.commit()

			expect(host.has(LifecycleModelQueuedProvider)).toBe(false)
			expect(host.has(LifecycleModelQueuedConsumer)).toBe(false)
			expect(host.isRunning(LifecycleModelQueuedProvider)).toBe(false)
			expect(host.isRunning(LifecycleModelQueuedConsumer)).toBe(false)
			expect(queuedCommitEvents).toEqual([
				'provider:start:1',
				'consumer:start:1',
				'consumer:cleanup:1',
				'provider:cleanup:1',
			])
		})
	})

	it('drains reentrant cleanups registered during generation teardown', async () => {
		await withCoreHost(async (host) => {
			host.add(LifecycleModelReentrantCleanup)
			await host.commit()
			host.remove(LifecycleModelReentrantCleanup)
			await host.commit()

			expect(reentrantCleanupOrder).toEqual(['outer', 'inner'])
			expect(host.isRunning(LifecycleModelReentrantCleanup)).toBe(false)
		})
	})

	it('does not publish a generation after late init settlement wins a timeout', async () => {
		await withCoreHost(
			async (host) => {
				host.add(LifecycleModelLateInit)
				await host.commitAllowFail()
				expect(host.isRunning(LifecycleModelLateInit)).toBe(false)

				resolveLateInit()
				await vi.waitFor(() => expect(lateCleanupRuns).toBe(1))
				expect(host.isRunning(LifecycleModelLateInit)).toBe(false)
			},
			{ registry: { drainTimeoutMs: 20 } },
		)
	})
})

async function runTrace(trace: Trace): Promise<void> {
	resetLifecycleModelState()
	const executed: Action[] = []
	try {
		await withCoreHost(async (host) => {
			for (const action of trace.actions) {
				executed.push(action)
				await applyAction(host, action)
				if (action === 'commit' || action === 'commit-allow-fail') {
					assertLifecycleInvariants(host, `${trace.name} after ${executed.join(' -> ')}`)
				}
			}
			expect(readRunningProjection(host)).toEqual(trace.finalRunning)
		})
	} catch (error) {
		const detail = `Lifecycle model trace failed: ${trace.name}\nactions: ${executed.join(' -> ')}`
		throw error instanceof Error
			? new Error(`${detail}\n${error.message}`, { cause: error })
			: error
	}
}

async function applyAction(host: CoreHost, action: Action): Promise<void> {
	switch (action) {
		case 'add-provider':
			host.add(LifecycleModelProvider)
			return
		case 'add-required':
			host.add(LifecycleModelRequiredConsumer)
			return
		case 'add-optional':
			host.add(LifecycleModelOptionalConsumer)
			return
		case 'add-independent':
			host.add(LifecycleModelIndependent)
			return
		case 'commit':
			await host.commit()
			return
		case 'commit-allow-fail':
			await host.commitAllowFail()
			return
		case 'fail-provider':
			providerShouldFail = true
			return
		case 'recover-provider':
			providerShouldFail = false
			return
		case 'restart-provider':
			host.restart(LifecycleModelProvider)
			return
		case 'replace-provider':
			host.replace(LifecycleModelProvider, LifecycleModelProviderReplacement)
			return
		default:
			action satisfies never
	}
}

function assertLifecycleInvariants(host: CoreHost, label: string): void {
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
		expect(running.has('provider'), `${label}: required consumer has running provider`).toBe(true)
		expect(host.require(LifecycleModelRequiredConsumer).provider.generation).toBe(
			host.require(LifecycleModelProvider).generation,
		)
	}

	if (!running.has('provider')) {
		expect(counters['optional-integration'].active, `${label}: absent provider integration`).toBe(0)
	}

	if (host.isRunning(LifecycleModelIndependent)) {
		expect(
			host.require(LifecycleModelIndependent).generation,
			`${label}: independent generation`,
		).toBe(1)
	}
}

function readRunningProjection(host: CoreHost): Set<NodeName> {
	const running = new Set<NodeName>()
	if (host.isRunning(LifecycleModelProvider)) running.add('provider')
	if (host.isRunning(LifecycleModelRequiredConsumer)) running.add('required')
	if (host.isRunning(LifecycleModelOptionalConsumer)) running.add('optional')
	if (host.isRunning(LifecycleModelIndependent)) running.add('independent')
	return running
}

function allAddOrders(): Action[][] {
	return permutations(addActions())
}

function legalIncrementalAddOrders(): Action[][] {
	return permutations(addActions()).filter(
		(actions) => actions.indexOf('add-provider') < actions.indexOf('add-required'),
	)
}

function addActions(): Action[] {
	return ['add-provider', 'add-required', 'add-optional', 'add-independent']
}

function interleaveCommits(actions: readonly Action[]): Action[] {
	const out: Action[] = []
	for (const action of actions) {
		out.push(action, 'commit')
	}
	return out
}

function permutations<T>(values: readonly T[]): T[][] {
	if (values.length <= 1) return [values.slice()]
	const out: T[][] = []
	for (let i = 0; i < values.length; i++) {
		const head = values[i]!
		const tail = values.slice(0, i).concat(values.slice(i + 1))
		for (const rest of permutations(tail)) out.push([head, ...rest])
	}
	return out
}
