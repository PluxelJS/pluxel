import type { StandardSchemaV1 } from '@standard-schema/spec'
import { parsePluginNodeAddress } from '@pluxel/core'
import {
	BasePlugin,
	Plugin,
	PluginLifecycleAssertionError,
	createCoreTestHost,
	type CorePluginTestChange,
	type CoreTestHost,
} from '@pluxel/core/internal/test'
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
		const configured = await host.add(V2Configured.nodeAddress(), { initialConfig: { value: 7 } })
		expect(configured.config).toEqual({ value: 7 })

		const [provider, consumer] = await host.add([
			V2Provider.nodeAddress(),
			V2Consumer.nodeAddress(),
		])
		expect(consumer.provider.ctx.pluginInfo.nodeAddress).toEqual(
			provider.ctx.pluginInfo.nodeAddress,
		)
		expect(host.require(V2Provider.nodeAddress())).toBe(provider)
		expect(host.isRunning(V2Consumer.nodeAddress())).toBe(true)

		const same = await host.add(V2Provider.nodeAddress())
		expect(same).toBe(provider)
	})

	it('supports immutable fork addresses and keeps fork generations isolated', async () => {
		await using host = createCoreTestHost()
		const East = V2Provider.nodeAddress('east')
		const West = V2Provider.nodeAddress('west')
		const [defaultProvider, east, west] = await host.add([V2Provider.nodeAddress(), East, West])

		expect(Object.isFrozen(East)).toBe(true)
		expect(east.constructor).toBe(V2Provider)
		expect(east).not.toBe(defaultProvider)
		expect(east.ctx).not.toBe(west.ctx)
		expect(east.ctx.pluginInfo.nodeAddress).toMatchObject({ variant: 'fork', forkId: 'east' })
	})

	it('requires original source evidence when a target installs an implementation', async () => {
		await using host = createCoreTestHost()
		const original = V2Provider.nodeAddress('isolated')
		const plain = parsePluginNodeAddress(original)
		for (const target of [V2Provider, plain, JSON.parse(JSON.stringify(original))]) {
			await expect(host.add(target as never)).rejects.toThrow(
				/original concrete Plugin class nodeAddress/,
			)
		}
		for (const target of [{ ...original }, Object.assign({}, original)]) {
			await expect(host.add(target)).rejects.toThrow(/copied or detached/)
		}
		const foreignRegistryPath = '../src/internal/plugin-address-evidence?test-copy'
		const foreign = (await import(
			foreignRegistryPath
		)) as typeof import('../src/internal/plugin-address-evidence')
		const foreignAddress = foreign.createPluginNodeAddressEvidence(original, {
			kind: 'constructor',
			implementation: V2Provider,
		})
		await expect(host.add(foreignAddress)).rejects.toThrow(/copied or detached/)
		expect(host.isRunning(original)).toBe(false)
		const instance = await host.add(original)
		expect(instance.constructor).toBe(V2Provider)
	})

	it.each([undefined, 'east'])(
		'rejects conflicting implementation evidence when adding the same node twice (%s)',
		async (forkId) => {
			await using host = createCoreTestHost()
			class Replacement extends V2Provider {}
			lowerTestReplacement(V2Provider, Replacement, { plugin: { forkable: true } })
			await expect(
				host.commit((change) => {
					change.add(V2Provider.nodeAddress(forkId))
					change.add(Replacement.nodeAddress(forkId))
				}),
			).rejects.toThrow(/Conflicting add.*different implementations/)
			expect(host.isRunning(V2Provider.nodeAddress(forkId))).toBe(false)
			await host.commit((change) => {
				change.add(V2Provider.nodeAddress(forkId))
				change.add(V2Provider.nodeAddress(forkId))
			})
			expect(host.require(V2Provider.nodeAddress(forkId)).constructor).toBe(V2Provider)
		},
	)

	it('compares repeated fork overrides by identity and exact implementation evidence', async () => {
		await using host = createCoreTestHost()
		await host.commit((change) => {
			change.add([
				V2Provider.nodeAddress(),
				V2Provider.nodeAddress('east'),
				V2Consumer.nodeAddress(),
			])
			for (let index = 0; index < 2; index++) {
				change.dependencies.setOverride({
					consumer: V2Consumer.nodeAddress(),
					requirement: V2Provider,
					provider: V2Provider.nodeAddress('east'),
				})
			}
		})
		expect(host.require(V2Consumer.nodeAddress()).provider.ctx.pluginInfo.nodeAddress).toEqual(
			parsePluginNodeAddress(V2Provider.nodeAddress('east')),
		)
		class Replacement extends V2Provider {}
		lowerTestReplacement(V2Provider, Replacement, { plugin: { forkable: true } })
		await expect(
			host.commit((change) => {
				change.dependencies.setOverride({
					consumer: V2Consumer.nodeAddress(),
					requirement: V2Provider,
					provider: V2Provider.nodeAddress('east'),
				})
				change.dependencies.setOverride({
					consumer: V2Consumer.nodeAddress(),
					requirement: V2Provider,
					provider: Replacement.nodeAddress('east'),
				})
			}),
		).rejects.toThrow(/Conflicting dependencies.setOverride/)
	})

	it('accepts abstract definition tokens as dependency requirements', async () => {
		await using host = createCoreTestHost()
		await host.commit((change) => {
			change.add([V2AbstractImplementation.nodeAddress(), V2AbstractConsumer.nodeAddress()])
			change.dependencies.setDefault({
				requirement: V2AbstractProvider,
				provider: V2AbstractImplementation,
			})
		})
		expect(host.require(V2AbstractConsumer.nodeAddress()).provider.value).toBe(
			'abstract-implementation',
		)
	})

	it('returns a frozen slot-free lifecycle failure summary', async () => {
		await using host = createCoreTestHost()
		const failure = await host.commitExpectFail((change) => change.add(V2Failure.nodeAddress()))

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
		const error = await host.add(V2Failure.nodeAddress()).catch((cause: unknown) => cause)

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
				change.add(V2Independent.nodeAddress())
			}) as never),
		).rejects.toThrow(/must be synchronous/i)
		expect(host.isRunning(V2Independent.nodeAddress())).toBe(false)

		await expect(host.commit(() => undefined)).rejects.toThrow(/at least one change/i)
		await expect(
			host.commit((change) => {
				change.add(V2Independent.nodeAddress())
				change.remove(V2Independent.nodeAddress())
			}),
		).rejects.toThrow(/conflicting/i)

		await host.commit((change) => {
			escaped = change
			change.add(V2Independent.nodeAddress())
		})
		expect(() => escaped!.restart(V2Independent.nodeAddress())).toThrow(/cannot escape/i)
	})

	it('fails concurrent mutation/query and lets disposal wait for admitted mutation', async () => {
		const host = createCoreTestHost({ plugins: { startTimeoutMs: 1_000 } })
		resetSlowStart()
		const pending = host.add(V2Slow.nodeAddress())
		expect(() => host.isRunning(V2Slow.nodeAddress())).toThrow(/in progress/i)
		await expect(host.add(V2Independent.nodeAddress())).rejects.toThrow(
			/literal batch|commit\(callback\)/i,
		)
		await slowStarted

		const firstDispose = host.dispose()
		expect(host.dispose()).toBe(firstDispose)
		expect(host[Symbol.asyncDispose]()).toBe(firstDispose)
		releaseSlowStart?.()
		await pending
		await firstDispose
		expect(() => host.isRunning(V2Slow.nodeAddress())).toThrow(/closing or closed/i)
		await expect(host.add(V2Independent.nodeAddress())).rejects.toThrow(/closing or closed/i)
	})

	it('restarts explicitly and stale-rejects old source addresses after replacement', async () => {
		await using host = createCoreTestHost()
		const EastV1 = V2Provider.nodeAddress('east-replacement')
		const [first, firstEast] = await host.add([V2Provider.nodeAddress(), EastV1])
		const restarted = await host.restart(V2Provider.nodeAddress())
		expect(restarted).not.toBe(first)

		class V2ProviderReplacement extends BasePlugin {
			readonly marker = 'replacement'
		}
		lowerTestReplacement(V2Provider, V2ProviderReplacement, {
			plugin: { forkable: true },
		})
		await host.replaceDefinition(V2Provider, V2ProviderReplacement)

		expect(() => host.require(V2Provider.nodeAddress())).toThrow(/stale plugin target/i)
		expect(() => host.require(EastV1)).toThrow(/stale plugin target/i)
		const EastV2 = V2ProviderReplacement.nodeAddress('east-replacement')
		expect(host.require(EastV2)).not.toBe(firstEast)
		expect(host.require(EastV2)).toBeInstanceOf(V2ProviderReplacement)
	})
})

async function compileOnlyCoreTestHostContract(host: CoreTestHost): Promise<void> {
	// @ts-expect-error Node selection uses an original source address, not a constructor.
	await host.add(V2Provider)
	// @ts-expect-error Portable identity alone cannot install an implementation.
	await host.add(parsePluginNodeAddress(V2Provider.nodeAddress()))
	const single = await host.add(V2Provider.nodeAddress())
	expectTypeOf(single).toEqualTypeOf<V2Provider>()

	const East = V2Provider.nodeAddress('compile-east')
	const tuple = await host.add([
		V2Provider.nodeAddress(),
		East,
		V2Independent.nodeAddress(),
	] as const)
	expectTypeOf(tuple).toEqualTypeOf<readonly [V2Provider, V2Provider, V2Independent]>()

	await host.commit((change) => change.add(V2Provider.nodeAddress()))
	await host.commit((change) => {
		change.add(V2Provider.nodeAddress())
	})
	await host.commit((change) => {
		change.add([V2AbstractImplementation.nodeAddress(), V2AbstractConsumer.nodeAddress()])
		change.dependencies.setDefault({
			requirement: V2AbstractProvider,
			provider: V2AbstractImplementation,
		})
	})

	// @ts-expect-error Async callbacks cannot satisfy the synchronous undefined-return contract.
	await host.commit(async (change) => change.add(V2Provider.nodeAddress()))
	// @ts-expect-error A callback cannot return an arbitrary value.
	await host.commit((_change) => 1)
	// @ts-expect-error Batch add intentionally has no heterogeneous initialConfig map.
	await host.add([V2Provider.nodeAddress(), V2Independent.nodeAddress()], {
		initialConfig: { value: 1 },
	})
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
	// @ts-expect-error Definition replacement accepts constructors, not fork addresses.
	await host.replaceDefinition(East, V2Provider)
	// @ts-expect-error Public author hosts do not expose root Context authority.
	void host.ctx
}

void compileOnlyCoreTestHostContract
