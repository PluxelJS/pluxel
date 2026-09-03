import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
	BasePlugin,
	Plugin,
	PluginLifecycleAssertionError,
	createCoreTestHost,
	definePluginFork,
	type CorePluginTestChange,
	type CoreTestHost,
} from '@pluxel/core/test'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { lowerTestReplacement } from './lowered-replacement'

const ConfigSchema: StandardSchemaV1<unknown, { value: number }> = {
	'~standard': {
		version: 1,
		vendor: 'pluxel:test',
		validate(value) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				return { issues: [{ message: 'Expected config object' }] }
			}
			const input = value as { value?: unknown }
			return typeof input.value === 'number'
				? { value: { value: input.value } }
				: { issues: [{ message: 'Expected numeric value', path: ['value'] }] }
		},
	},
}

@Plugin({ forkable: true })
class V2Provider extends BasePlugin {
	readonly marker = 'provider'
}

@Plugin()
class V2Consumer extends BasePlugin {
	constructor(readonly provider: V2Provider) {
		super()
	}
}

@Plugin()
class V2Configured extends BasePlugin {
	readonly config = this.configs.use(ConfigSchema)
}

@Plugin()
class V2Independent extends BasePlugin {}

abstract class V2AbstractProvider extends BasePlugin {
	abstract readonly value: string
}

@Plugin(V2AbstractProvider)
class V2AbstractImplementation extends V2AbstractProvider {
	readonly value = 'abstract-implementation'
}

@Plugin()
class V2AbstractConsumer extends BasePlugin {
	constructor(readonly provider: V2AbstractProvider) {
		super()
	}
}

@Plugin()
class V2Failure extends BasePlugin {
	protected override init(): void {
		throw new Error('expected-v2-start-failure')
	}
}

let releaseSlowStart: (() => void) | undefined
let markSlowStarted: (() => void) | undefined
let slowStarted = Promise.resolve()

function resetSlowStart(): void {
	slowStarted = new Promise<void>((resolve) => {
		markSlowStarted = resolve
	})
	releaseSlowStart = undefined
}

@Plugin()
class V2Slow extends BasePlugin {
	protected override init(): Promise<void> {
		markSlowStarted?.()
		return new Promise<void>((resolve) => {
			releaseSlowStart = resolve
		})
	}
}

describe('createCoreTestHost()', () => {
	it('immediately adds single and batch targets and returns exact running instances', async () => {
		await using host = createCoreTestHost()
		const configured = await host.add(V2Configured, { initialConfig: { value: 7 } })
		expect(configured.config).toEqual({ value: 7 })

		const [provider, consumer] = await host.add([V2Provider, V2Consumer])
		expect(consumer.provider.ctx.pluginInfo.nodeAddress).toEqual(
			provider.ctx.pluginInfo.nodeAddress,
		)
		expect(host.require(V2Provider)).toBe(provider)
		expect(host.isRunning(V2Consumer)).toBe(true)

		const same = await host.add(V2Provider)
		expect(same).toBe(provider)
	})

	it('supports immutable fork refs and keeps fork generations isolated', async () => {
		await using host = createCoreTestHost()
		const East = definePluginFork(V2Provider, 'east')
		const West = definePluginFork(V2Provider, 'west')
		const [defaultProvider, east, west] = await host.add([V2Provider, East, West])

		expect(Object.isFrozen(East)).toBe(true)
		expect(east.constructor).toBe(V2Provider)
		expect(east).not.toBe(defaultProvider)
		expect(east.ctx).not.toBe(west.ctx)
		expect(east.ctx.pluginInfo.nodeAddress).toMatchObject({ variant: 'fork', forkId: 'east' })
	})

	it('accepts abstract definition tokens as dependency requirements', async () => {
		await using host = createCoreTestHost()
		await host.commit((change) => {
			change.add([V2AbstractImplementation, V2AbstractConsumer])
			change.dependencies.setDefault({
				requirement: V2AbstractProvider,
				provider: V2AbstractImplementation,
			})
		})
		expect(host.require(V2AbstractConsumer).provider.value).toBe('abstract-implementation')
	})

	it('returns a frozen slot-free lifecycle failure summary', async () => {
		await using host = createCoreTestHost()
		const failure = await host.commitExpectFail((change) => change.add(V2Failure))

		expect(failure.lifecycleReport.ok).toBe(false)
		expect(failure.lifecycleReport.issues).toHaveLength(1)
		expect(failure.lifecycleReport.issues[0]).toMatchObject({
			plugin: { variant: 'default' },
			phase: 'start',
			kind: 'start-failed',
		})
		expect(Object.isFrozen(failure)).toBe(true)
		expect(Object.isFrozen(failure.lifecycleReport)).toBe(true)
		expect(Object.isFrozen(failure.lifecycleReport.issues)).toBe(true)
		expect(Object.keys(failure)).toEqual(['lifecycleReport'])
		expect(Object.keys(failure.lifecycleReport.issues[0]!.plugin)).toEqual([
			'definition',
			'variant',
		])
	})

	it('preserves strict failure diagnostics in PluginLifecycleAssertionError', async () => {
		await using host = createCoreTestHost()
		const error = await host.add(V2Failure).catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(PluginLifecycleAssertionError)
		expect(error).toMatchObject({
			code: 'PLUGIN_TEST_LIFECYCLE_ASSERTION_FAILED',
			operation: 'add',
		})
		expect(
			(error as PluginLifecycleAssertionError).summary.lifecycleReport.issues[0],
		).toMatchObject({ kind: 'start-failed' })
	})

	it('enforces callback sync, lifetime, empty, and conflict rules before applying', async () => {
		await using host = createCoreTestHost()
		let escaped: CorePluginTestChange | undefined

		await expect(
			host.commit((async (change: CorePluginTestChange) => {
				change.add(V2Independent)
			}) as never),
		).rejects.toThrow(/must be synchronous/i)
		expect(host.isRunning(V2Independent)).toBe(false)

		await expect(host.commit(() => undefined)).rejects.toThrow(/at least one change/i)
		await expect(
			host.commit((change) => {
				change.add(V2Independent)
				change.remove(V2Independent)
			}),
		).rejects.toThrow(/conflicting/i)

		await host.commit((change) => {
			escaped = change
			change.add(V2Independent)
		})
		expect(() => escaped!.restart(V2Independent)).toThrow(/cannot escape/i)
	})

	it('fails concurrent mutation/query and lets disposal wait for admitted mutation', async () => {
		const host = createCoreTestHost({ plugins: { startTimeoutMs: 1_000 } })
		resetSlowStart()
		const pending = host.add(V2Slow)
		expect(() => host.isRunning(V2Slow)).toThrow(/in progress/i)
		await expect(host.add(V2Independent)).rejects.toThrow(/literal batch|commit\(callback\)/i)
		await slowStarted

		const firstDispose = host.dispose()
		expect(host.dispose()).toBe(firstDispose)
		expect(host[Symbol.asyncDispose]()).toBe(firstDispose)
		releaseSlowStart?.()
		await pending
		await firstDispose
		expect(() => host.isRunning(V2Slow)).toThrow(/closing or closed/i)
		await expect(host.add(V2Independent)).rejects.toThrow(/closing or closed/i)
	})

	it('restarts explicitly and stale-rejects old constructors and fork refs after replacement', async () => {
		await using host = createCoreTestHost()
		const EastV1 = definePluginFork(V2Provider, 'east-replacement')
		const [first, firstEast] = await host.add([V2Provider, EastV1])
		const restarted = await host.restart(V2Provider)
		expect(restarted).not.toBe(first)

		class V2ProviderReplacement extends BasePlugin {
			readonly marker = 'replacement'
		}
		lowerTestReplacement(V2Provider, V2ProviderReplacement, {
			plugin: { forkable: true },
		})
		await host.replaceDefinition(V2Provider, V2ProviderReplacement)

		expect(() => host.require(V2Provider)).toThrow(/stale plugin target/i)
		expect(() => host.require(EastV1)).toThrow(/stale plugin target/i)
		const EastV2 = definePluginFork(V2ProviderReplacement, 'east-replacement')
		expect(host.require(EastV2)).not.toBe(firstEast)
		expect(host.require(EastV2)).toBeInstanceOf(V2ProviderReplacement)
	})
})

async function compileOnlyCoreTestHostContract(host: CoreTestHost): Promise<void> {
	const single = await host.add(V2Provider)
	expectTypeOf(single).toEqualTypeOf<V2Provider>()

	const East = definePluginFork(V2Provider, 'compile-east')
	const tuple = await host.add([V2Provider, East, V2Independent] as const)
	expectTypeOf(tuple).toEqualTypeOf<readonly [V2Provider, V2Provider, V2Independent]>()

	await host.commit((change) => change.add(V2Provider))
	await host.commit((change) => {
		change.add(V2Provider)
	})
	await host.commit((change) => {
		change.add([V2AbstractImplementation, V2AbstractConsumer])
		change.dependencies.setDefault({
			requirement: V2AbstractProvider,
			provider: V2AbstractImplementation,
		})
	})

	// @ts-expect-error Async callbacks cannot satisfy the synchronous undefined-return contract.
	await host.commit(async (change) => change.add(V2Provider))
	// @ts-expect-error A callback cannot return an arbitrary value.
	await host.commit((_change) => 1)
	// @ts-expect-error Batch add intentionally has no heterogeneous initialConfig map.
	await host.add([V2Provider, V2Independent], { initialConfig: { value: 1 } })
	await host.commit((change) =>
		change.dependencies.setDefault({
			requirement: V2Provider,
			// @ts-expect-error A fork cannot be a global provider default.
			provider: East,
		}),
	)
	await host.commit((change) =>
		change.dependencies.setDefault({
			requirement: V2AbstractProvider,
			// @ts-expect-error A requirement token cannot be used as a concrete provider.
			provider: V2AbstractProvider,
		}),
	)
	// @ts-expect-error Definition replacement accepts constructors, not fork refs.
	await host.replaceDefinition(East, V2Provider)
	// @ts-expect-error Public author hosts do not expose root Context authority.
	void host.ctx
}

void compileOnlyCoreTestHostContract
