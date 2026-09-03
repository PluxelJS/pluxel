import {
	BasePlugin,
	Plugin,
	definePluginRef,
	pluginDefinitionAddressOf,
	pluginNodeAddressOf,
} from '@pluxel/core/test'
import { withCoreInternalTestHost } from '@pluxel/core/internal/test'
import { requirePluginService } from '@pluxel/core/internal'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lowerTestReplacement } from './lowered-replacement'
import {
	OptionalProvider as OptionalProviderCtor,
	resetOptionalProvider,
	setOptionalProviderFailure,
	type OptionalProvider as OptionalProviderType,
} from './plugins/OptionalProvider'
import {
	resetSecondOptionalProvider,
	SecondOptionalProvider as SecondOptionalProviderCtor,
	type SecondOptionalProvider as SecondOptionalProviderType,
} from './plugins/SecondOptionalProvider'

const OptionalProviderRef = definePluginRef<OptionalProviderType>()
const SecondOptionalProviderRef = definePluginRef<SecondOptionalProviderType>()

let consumerStarts = 0
let consumerCleanups = 0
let integrationCleanups = 0
const observedGenerations: string[] = []

@Plugin({ displayName: 'Optional consumer' })
class OptionalConsumer extends BasePlugin {
	readonly generation = ++consumerStarts

	override init() {
		this.plugins.use(OptionalProviderRef, (provider) => {
			observedGenerations.push(`first:${provider.generation}`)
			return () => {
				integrationCleanups++
			}
		})
		this.plugins.use(SecondOptionalProviderRef, (provider) => {
			observedGenerations.push(`second:${provider.generation}`)
			return () => {
				integrationCleanups++
			}
		})
		return () => {
			consumerCleanups++
		}
	}
}

class OptionalProviderReplacement extends OptionalProviderCtor {}

@Plugin({ displayName: 'Required optional-provider consumer' })
class RequiredOptionalProviderConsumer extends BasePlugin {
	constructor(readonly provider: OptionalProviderCtor) {
		super()
	}
}

const RequiredOptionalProviderConsumerRef = definePluginRef<RequiredOptionalProviderConsumer>()
let nestedOptionalConsumerStarts = 0

abstract class AbstractOptionalProvider extends BasePlugin {
	abstract readonly value: string
}

@Plugin(AbstractOptionalProvider)
class ConcreteAbstractOptionalProvider extends AbstractOptionalProvider {
	readonly value = 'concrete'
}

const AbstractOptionalProviderRef = definePluginRef<AbstractOptionalProvider>()
let abstractOptionalSetups = 0

@Plugin()
class AbstractOptionalConsumer extends BasePlugin {
	override init() {
		this.plugins.use(AbstractOptionalProviderRef, () => {
			abstractOptionalSetups++
		})
	}
}

@Plugin({ displayName: 'Nested optional consumer' })
class NestedOptionalConsumer extends BasePlugin {
	readonly generation = ++nestedOptionalConsumerStarts

	override init() {
		this.plugins.use(RequiredOptionalProviderConsumerRef, () => undefined)
	}
}

describe('static optional Plugin integration', () => {
	beforeAll(() => {
		lowerTestReplacement(OptionalProviderCtor, OptionalProviderReplacement, {
			plugin: { displayName: 'Optional provider replacement' },
		})
	})
	beforeEach(() => {
		consumerStarts = 0
		consumerCleanups = 0
		integrationCleanups = 0
		nestedOptionalConsumerStarts = 0
		observedGenerations.length = 0
		resetOptionalProvider()
		resetSecondOptionalProvider()
		abstractOptionalSetups = 0
	})

	it('does not resolve an abstract provider default through a concrete-only PluginRef', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add([ConcreteAbstractOptionalProvider, AbstractOptionalConsumer])
			await host.commit()

			const update = registry.beginUpdate({ reason: 'core-test' })
			update.setProviderDefault(
				pluginDefinitionAddressOf(AbstractOptionalProvider),
				pluginNodeAddressOf(ConcreteAbstractOptionalProvider),
			)
			const prepared = update.prepare()
			const result = await prepared.commit()

			expect(result.ok).toBe(true)
			expect(host.isRunning(AbstractOptionalConsumer)).toBe(true)
			expect(abstractOptionalSetups).toBe(0)

			const cleanup = registry.beginUpdate({ reason: 'core-test' })
			cleanup.setProviderDefault(pluginDefinitionAddressOf(AbstractOptionalProvider), null)
			const cleanupResult = await cleanup.commit()
			expect(cleanupResult.ok).toBe(true)
		})
	})

	it('does not disturb consumers on absent -> absent retries and restarts them on real transitions', async () => {
		await withCoreInternalTestHost(async (host) => {
			await host.start(OptionalConsumer)
			const initiallyAbsent = host.require(OptionalConsumer)
			expect(observedGenerations).toEqual([])

			setOptionalProviderFailure(true)
			host.add(OptionalProviderCtor)
			await host.commitAllowFail()
			expect(host.require(OptionalConsumer)).toBe(initiallyAbsent)
			expect(consumerStarts).toBe(1)

			await host.commitAllowFail()
			expect(host.require(OptionalConsumer)).toBe(initiallyAbsent)
			expect(consumerStarts).toBe(1)

			setOptionalProviderFailure(false)
			await host.commit()
			expect(host.require(OptionalConsumer)).not.toBe(initiallyAbsent)
			expect(consumerStarts).toBe(2)
			expect(observedGenerations).toHaveLength(1)

			host.restart(OptionalProviderCtor)
			await host.commit()
			expect(consumerStarts).toBe(3)
			expect(observedGenerations).toHaveLength(2)

			setOptionalProviderFailure(true)
			host.restart(OptionalProviderCtor)
			await host.commitAllowFail()
			const runningAbsent = host.require(OptionalConsumer)
			expect(consumerStarts).toBe(4)
			expect(observedGenerations).toHaveLength(2)

			await host.commitAllowFail()
			expect(host.require(OptionalConsumer)).toBe(runningAbsent)
			expect(consumerStarts).toBe(4)

			setOptionalProviderFailure(false)
			await host.commit()
			expect(consumerStarts).toBe(5)
			expect(observedGenerations).toHaveLength(3)

			host.remove(OptionalProviderCtor)
			await host.commit()
			expect(consumerStarts).toBe(6)
			expect(observedGenerations).toHaveLength(3)
			expect(consumerCleanups).toBe(5)
			expect(integrationCleanups).toBe(3)
		})
	})

	it('restarts one consumer generation for provider replacement', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add([OptionalProviderCtor, OptionalConsumer])
			await host.commit()
			const first = host.require(OptionalConsumer)

			host.replace(OptionalProviderCtor, OptionalProviderReplacement)
			const summary = await host.commit()

			expect(host.require(OptionalConsumer)).not.toBe(first)
			expect(consumerStarts).toBe(2)
			expect(observedGenerations).toHaveLength(2)
			expect(summary.pluginChanges.restarted).toEqual([
				registry.resolvePluginNode(OptionalConsumer),
			])
		})
	})

	it('restarts optional consumers outside a required removal cascade', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			host.add([OptionalProviderCtor, RequiredOptionalProviderConsumer, NestedOptionalConsumer])
			await host.commit()
			const firstOptionalConsumer = host.require(NestedOptionalConsumer)

			host.remove(OptionalProviderCtor)
			const summary = await host.commit()

			expect(host.has(OptionalProviderCtor)).toBe(false)
			expect(host.has(RequiredOptionalProviderConsumer)).toBe(false)
			expect(host.require(NestedOptionalConsumer)).not.toBe(firstOptionalConsumer)
			expect(nestedOptionalConsumerStarts).toBe(2)
			expect(summary.pluginChanges.restarted).toEqual([
				registry.resolvePluginNode(NestedOptionalConsumer),
			])
		})
	})

	it('unions overlapping provider transitions so each consumer restarts once', async () => {
		await withCoreInternalTestHost(async (host) => {
			const registry = requirePluginService(host.ctx)
			await host.start(OptionalConsumer)
			host.add([OptionalProviderCtor, SecondOptionalProviderCtor])
			const summary = await host.commit()

			expect(consumerStarts).toBe(2)
			expect(new Set(observedGenerations.map((value) => value.split(':')[0]))).toEqual(
				new Set(['first', 'second']),
			)
			expect(summary.pluginChanges.restarted).toEqual([
				registry.resolvePluginNode(OptionalConsumer),
			])
		})
	})
})
