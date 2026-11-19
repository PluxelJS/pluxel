import {
	BasePlugin,
	Plugin,
	definePluginRef,
	withCoreInternalTestHost,
} from '@pluxel/core/internal/test'
import { requirePluginService } from '@pluxel/core/internal'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	OptionalProvider as OptionalProviderCtor,
	resetOptionalProvider,
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
const observedGenerations: string[] = []

@Plugin({ displayName: 'Optional consumer' })
class OptionalConsumer extends BasePlugin {
	readonly generation = ++consumerStarts

	override init() {
		this.plugins.use(OptionalProviderRef, (provider) => {
			observedGenerations.push(`first:${provider.generation}`)
		})
		this.plugins.use(SecondOptionalProviderRef, (provider) => {
			observedGenerations.push(`second:${provider.generation}`)
		})
	}
}

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
	beforeEach(() => {
		consumerStarts = 0
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
				AbstractOptionalProvider.address(),
				ConcreteAbstractOptionalProvider.nodeAddress(),
			)
			const prepared = update.prepare()
			const result = await prepared.commit()

			expect(result.ok).toBe(true)
			expect(host.isRunning(AbstractOptionalConsumer)).toBe(true)
			expect(abstractOptionalSetups).toBe(0)

			const cleanup = registry.beginUpdate({ reason: 'core-test' })
			cleanup.setProviderDefault(AbstractOptionalProvider.address(), null)
			const cleanupResult = await cleanup.commit()
			expect(cleanupResult.ok).toBe(true)
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
