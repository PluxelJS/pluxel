import {
	BasePlugin,
	Plugin,
	definePluginRef,
	createCoreInternalTestHost,
} from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'

let providerFails: boolean

@Plugin()
class OptionalProvider extends BasePlugin {
	readonly value = 'first'

	override init() {
		if (providerFails) throw new Error('optional provider failed')
	}
}

@Plugin()
class SecondProvider extends BasePlugin {
	readonly value = 'second'
}

const FirstRef = definePluginRef<OptionalProvider>()
const SecondRef = definePluginRef<SecondProvider>()
let consumerStarts: number

@Plugin()
class OptionalConsumer extends BasePlugin {
	readonly links = new Set<string>()

	override init() {
		consumerStarts++
		this.plugins.use(FirstRef, ({ value }) => {
			this.links.add(value)
			return () => {
				this.links.delete(value)
			}
		})
		this.plugins.use(SecondRef, ({ value }) => {
			this.links.add(value)
			return () => {
				this.links.delete(value)
			}
		})
	}
}

it('ignores absent-to-absent retries and restarts once when two optional providers become available', async () => {
	providerFails = true
	consumerStarts = 0
	await using host = createCoreInternalTestHost()
	const absent = await host.start(OptionalConsumer)
	expect(absent.links.size).toBe(0)

	host.add(OptionalProvider)
	await host.commitAllowFail()
	await host.commitAllowFail()
	expect(host.require(OptionalConsumer)).toBe(absent)

	providerFails = false
	host.add(SecondProvider)
	await host.commit()
	const connected = host.require(OptionalConsumer)
	expect(connected.links).toEqual(new Set(['first', 'second']))
	expect(consumerStarts).toBe(2)

	host.remove(OptionalProvider)
	await host.commit()
	expect(connected.links.size).toBe(0)
	expect(host.require(OptionalConsumer).links).toEqual(new Set(['second']))
})

@Plugin()
class RequiredConsumer extends BasePlugin {
	constructor(readonly provider: SecondProvider) {
		super()
	}
}

const RequiredConsumerRef = definePluginRef<RequiredConsumer>()

@Plugin()
class OptionalObserver extends BasePlugin {
	providerValue?: string

	override init() {
		this.plugins.use(RequiredConsumerRef, (consumer) => {
			this.providerValue = consumer.provider.value
		})
	}
}

it('keeps optional consumers running when the required provider chain is removed', async () => {
	await using host = createCoreInternalTestHost()
	host.add([OptionalObserver, RequiredConsumer, SecondProvider])
	await host.commit()
	expect(host.require(OptionalObserver).providerValue).toBe('second')

	host.remove(SecondProvider)
	await host.commit()
	expect(host.get(RequiredConsumer)).toBeUndefined()
	expect(host.require(OptionalObserver).providerValue).toBeUndefined()
})

abstract class AbstractProvider extends BasePlugin {}

@Plugin(AbstractProvider)
class ConcreteProvider extends AbstractProvider {}
const AbstractRef = definePluginRef<AbstractProvider>()

@Plugin()
class AbstractObserver extends BasePlugin {
	connected = false

	override init() {
		this.plugins.use(AbstractRef, () => {
			this.connected = true
		})
	}
}

it('does not connect an optional reference through an abstract provider default', async () => {
	await using host = createCoreInternalTestHost()
	host.add([ConcreteProvider, AbstractObserver])
	await host.commit()

	const update = host.pluginService.beginUpdate({ reason: 'set provider default' })
	update.setProviderDefault(AbstractProvider.address(), ConcreteProvider.nodeAddress())
	try {
		expect(await update.commit()).toMatchObject({ ok: true })
		expect(host.require(AbstractObserver).connected).toBe(false)
	} finally {
		const reset = host.pluginService.beginUpdate({ reason: 'clear provider default' })
		reset.setProviderDefault(AbstractProvider.address(), null)
		await reset.commit()
	}
})
