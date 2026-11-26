import { closeOwnerInvocations } from '@pluxel/core/internal'
import {
	BasePlugin,
	Plugin,
	definePluginRef,
	createCoreInternalTestHost,
} from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'
import { lowerTestReplacement } from '@pluxel/test/unsafe'

let getterWait: Promise<void>

@Plugin()
class Provider extends BasePlugin {
	value = 0
	callable: unknown
	pending: Promise<unknown> = Promise.resolve()
	lastWriter: unknown

	set number(value: number) {
		this.value = value
		this.lastWriter = this.ctx.caller
	}

	get callerAfterGetter() {
		return this.callerAfter(getterWait)
	}

	get callableGetter() {
		return () => this.ctx.caller
	}

	async callerAfter(wait: Promise<unknown>) {
		await wait
		return this.ctx.caller
	}

	increment() {
		return ++this.value
	}
}

const ProviderRef = definePluginRef<Provider>()

@Plugin()
class Consumer extends BasePlugin {
	optional?: Provider

	constructor(readonly provider: Provider) {
		super()
	}

	override init() {
		this.plugins.use(ProviderRef, (provider) => {
			this.optional = provider
		})
	}
}

@Plugin()
class Peer extends BasePlugin {
	constructor(readonly provider: Provider) {
		super()
	}
}

it('pins asynchronous calls and setter attribution to each consumer while sharing provider state', async () => {
	await using host = createCoreInternalTestHost()
	host.add([Consumer, Peer, Provider])
	await host.commit()
	const raw = host.require(Provider)
	const first = host.require(Consumer)
	const second = host.require(Peer)
	expect(first.optional).toBe(first.provider)

	const hold = Promise.withResolvers<void>()
	const fromFirst = first.provider.callerAfter(hold.promise)
	expect(await second.provider.callerAfter(Promise.resolve())).toBe(second.ctx)
	hold.resolve()
	expect(await fromFirst).toBe(first.ctx)
	first.provider.value = 5
	expect(second.provider.increment()).toBe(6)
	second.provider.number = 7
	expect(raw.value).toBe(7)
	expect(raw.lastWriter).toBe(second.ctx)
})

it('keeps late fields and functions off the dependency surface', async () => {
	await using host = createCoreInternalTestHost()
	const raw = await host.start(Provider)
	Object.assign(raw, { late: 1, callable: () => raw.ctx })
	host.add(Consumer)
	await host.commit()
	const { provider } = host.require(Consumer)

	expect(raw).toHaveProperty('late', 1)
	expect(provider).not.toHaveProperty('late')
	expect(() => Object.defineProperty(provider, 'value', { value: 9 })).toThrow(TypeError)
	expect(() => provider.callable).toThrow(/plugin_caller_view_callable_field_unsupported/)
	expect(() => provider.callableGetter).toThrow(/plugin_caller_view_callable_field_unsupported/)
})

it('withdraws cached reads, writes, and methods after replacing the provider', async () => {
	class Replacement extends Provider {}
	lowerTestReplacement(Provider, Replacement)
	await using host = createCoreInternalTestHost()
	await host.start(Provider)
	const { provider: previous } = await host.start(Consumer)
	const cached = previous.increment

	host.replace(Provider, Replacement)
	await host.commit()
	const replacement = host.require(Provider)
	expect(replacement).toBeInstanceOf(Replacement)
	expect(host.require(Consumer).provider.increment()).toBe(1)
	expect(replacement.value).toBe(1)
	expect(() => previous.value).toThrow(/owner stopped/i)
	expect(() => {
		previous.value = 100
	}).toThrow(/owner stopped/i)
	expect(cached).toThrow(/owner stopped/i)
})

it.each(['method', 'getter', 'field'] as const)(
	'holds the provider admission open for a Promise from a %s until it settles',
	async (access) => {
		await using host = createCoreInternalTestHost()
		host.add([Consumer, Provider])
		await host.commit()
		const raw = host.require(Provider)
		const consumer = host.require(Consumer)
		const release = Promise.withResolvers<void>()
		getterWait = release.promise
		raw.pending = release.promise.then(() => consumer.ctx)
		const { provider } = consumer
		const pending = {
			method: () => provider.callerAfter(release.promise),
			getter: () => provider.callerAfterGetter,
			field: () => provider.pending,
		}[access]()

		const draining = closeOwnerInvocations(raw.ctx)
		try {
			expect(draining).toBeInstanceOf(Promise)
			expect(() => provider.increment()).toThrow(/owner stopped/i)
		} finally {
			release.resolve()
			await draining
		}
		await expect(pending).resolves.toBe(consumer.ctx)
	},
)
