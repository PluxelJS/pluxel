import { BasePlugin, Plugin, definePluginRef } from '@pluxel/core/test'
import { withCoreInternalTestHost } from '@pluxel/core/internal/test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { lowerTestReplacement } from './lowered-replacement'

let providerCleanups = 0
const invocationReceivers: unknown[] = []
const setterCallers: unknown[] = []
let getterWait: Promise<void> = Promise.resolve()

@Plugin({ displayName: 'Caller-view provider' })
class CallerViewProvider extends BasePlugin {
	value = 0
	callableField: unknown = undefined
	promiseField: Promise<unknown> = Promise.resolve()

	set callerScopedValue(value: number) {
		setterCallers.push(this.ctx.caller)
		this.value = value
	}

	get callerScopedValue(): number {
		return this.value
	}

	get callerAfterGetter() {
		return (async () => {
			await getterWait
			return this.ctx.caller
		})()
	}

	get callableGetter() {
		return () => this.ctx.caller
	}

	override init() {
		return () => {
			providerCleanups++
		}
	}

	inspectAuthorFacades() {
		return {
			caller: this.ctx.caller,
			plugins: this.plugins,
			parts: this.parts,
			configs: this.configs,
		}
	}

	inspectContext() {
		return this.ctx
	}

	increment(): number {
		return ++this.value
	}

	captureInvocationReceiver(): void {
		invocationReceivers.push(this)
	}

	async captureInvocationReceiverAcross(wait: Promise<unknown>) {
		const receiver = () => this
		await wait
		return [receiver(), this] as const
	}

	async callerAfter(wait: Promise<unknown>) {
		await wait
		return this.ctx.caller
	}

	async incrementAcross(wait: Promise<unknown>): Promise<number> {
		this.value += 1
		await wait
		this.value += 1
		return this.value
	}

	assignThroughAccessor(value: number): void {
		this.callerScopedValue = value
	}

	invokeCallableField(): unknown {
		return (this.callableField as () => unknown)()
	}

	addDynamicField(): void {
		;(this as unknown as { dynamic?: number }).dynamic = 1
	}
}

const CallerViewProviderRef = definePluginRef<CallerViewProvider>()

@Plugin({ displayName: 'Caller-view consumer' })
class CallerViewConsumer extends BasePlugin {
	optionalMatchesRequired = false

	constructor(readonly provider: CallerViewProvider) {
		super()
	}

	override init() {
		this.plugins.use(CallerViewProviderRef, (provider) => {
			this.optionalMatchesRequired = provider === this.provider
		})
	}
}

@Plugin({ displayName: 'Caller-view peer' })
class CallerViewPeer extends BasePlugin {
	constructor(readonly provider: CallerViewProvider) {
		super()
	}
}

class CallerViewProviderReplacement extends CallerViewProvider {}

describe('generation-bound Plugin caller facade', () => {
	beforeAll(() => {
		lowerTestReplacement(CallerViewProvider, CallerViewProviderReplacement, {
			plugin: { displayName: 'Caller-view replacement' },
		})
	})

	beforeEach(() => {
		providerCleanups = 0
		invocationReceivers.length = 0
		setterCallers.length = 0
		getterWait = Promise.resolve()
	})

	it('pins caller Context per consumer and shares one view across required and optional edges', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer, CallerViewPeer])
			await host.commit()

			const raw = host.require(CallerViewProvider)
			const consumer = host.require(CallerViewConsumer)
			const peer = host.require(CallerViewPeer)
			expect(consumer.provider === raw).toBe(false)
			expect(peer.provider === consumer.provider).toBe(false)
			expect(consumer.optionalMatchesRequired).toBe(true)

			const [consumerCaller, peerCaller] = await Promise.all([
				consumer.provider.callerAfter(Promise.resolve()),
				peer.provider.callerAfter(Promise.resolve()),
			])
			expect(consumerCaller).toBe(consumer.ctx)
			expect(peerCaller).toBe(peer.ctx)

			const facades = consumer.provider.inspectAuthorFacades()
			expect(facades.caller).toBe(consumer.ctx)
			expect(facades.plugins).toBeDefined()
			expect(facades.parts).toBeDefined()
			expect(facades.configs).toBeDefined()

			const callerContext = consumer.provider.inspectContext()
			expect(Object.hasOwn(callerContext, 'pluginInfo')).toBe(true)
			expect(callerContext.pluginInfo).toBe(raw.ctx.pluginInfo)
			expect(callerContext.caller).toBe(consumer.ctx)
			const mutable = callerContext as unknown as { pluginInfo: unknown }
			expect(() => {
				mutable.pluginInfo = {}
			}).toThrow(TypeError)
			expect(() => Object.defineProperty(callerContext, 'pluginInfo', { value: {} })).toThrow(
				TypeError,
			)
			expect(Reflect.deleteProperty(callerContext, 'pluginInfo')).toBe(false)
			expect(callerContext.pluginInfo).toBe(raw.ctx.pluginInfo)
		})
	})

	it('writes author fields through to the pinned provider without shadow state', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()

			const raw = host.require(CallerViewProvider)
			const view = host.require(CallerViewConsumer).provider
			view.value = 4
			expect(raw.value).toBe(4)
			raw.value = 8
			expect(view.value).toBe(8)
			expect(view.increment()).toBe(9)
			expect(raw.value).toBe(9)
		})
	})

	it('runs prototype setters with the caller pinned to each consumer generation', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer, CallerViewPeer])
			await host.commit()

			const raw = host.require(CallerViewProvider)
			const consumer = host.require(CallerViewConsumer)
			const peer = host.require(CallerViewPeer)
			consumer.provider.callerScopedValue = 4
			peer.provider.callerScopedValue = 8
			consumer.provider.assignThroughAccessor(12)

			expect(setterCallers).toEqual([consumer.ctx, peer.ctx, consumer.ctx])
			expect(raw.value).toBe(12)
			expect(consumer.provider.callerScopedValue).toBe(12)
		})
	})

	it('uses one stable edge facade and a fresh receiver for each accepted invocation', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()

			const stable = host.require(CallerViewConsumer).provider
			stable.captureInvocationReceiver()
			stable.captureInvocationReceiver()

			expect(invocationReceivers).toHaveLength(2)
			expect(invocationReceivers[0]).not.toBe(stable)
			expect(invocationReceivers[1]).not.toBe(stable)
			expect(invocationReceivers[0]).not.toBe(invocationReceivers[1])
		})
	})

	it('isolates call receivers for overlapping invocations on one generation edge', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()

			const stable = host.require(CallerViewConsumer).provider
			const firstRelease = Promise.withResolvers<void>()
			const secondRelease = Promise.withResolvers<void>()
			const first = stable.captureInvocationReceiverAcross(firstRelease.promise)
			const second = stable.captureInvocationReceiverAcross(secondRelease.promise)

			firstRelease.resolve()
			secondRelease.resolve()
			const [firstReceivers, secondReceivers] = await Promise.all([first, second])
			expect(firstReceivers[0]).toBe(firstReceivers[1])
			expect(secondReceivers[0]).toBe(secondReceivers[1])
			expect(firstReceivers[0]).not.toBe(secondReceivers[0])
			expect(firstReceivers[0]).not.toBe(stable)
		})
	})

	it('uses a non-extensible descriptor facade without changing the raw provider', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()

			const raw = host.require(CallerViewProvider)
			const view = host.require(CallerViewConsumer).provider
			const prototype = Object.getPrototypeOf(raw)
			expect(() => Object.defineProperty(view, 'value', { value: 10 })).toThrow(TypeError)
			expect(Reflect.deleteProperty(view, 'value')).toBe(false)
			expect(() => Object.setPrototypeOf(view, {})).toThrow(TypeError)
			expect(Object.isExtensible(view)).toBe(false)
			expect(Object.preventExtensions(view)).toBe(view)
			expect(Reflect.set(view, Symbol('internal'), true)).toBe(false)
			expect(Object.getOwnPropertyDescriptor(view, 'value')).toMatchObject({
				configurable: false,
			})

			expect(Object.isExtensible(raw)).toBe(true)
			expect(Object.getPrototypeOf(raw)).toBe(prototype)
			expect(raw.value).toBe(0)
		})
	})

	it('rejects function-valued instance fields and accessor results at the caller boundary', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()

			const raw = host.require(CallerViewProvider)
			const view = host.require(CallerViewConsumer).provider
			raw.callableField = () => raw.ctx.caller

			expect(() => view.callableField).toThrow(/plugin_caller_view_callable_field_unsupported/)
			expect(() => view.callableGetter).toThrow(/plugin_caller_view_callable_field_unsupported/)
			expect(() => view.invokeCallableField()).toThrow(
				/plugin_caller_view_callable_field_unsupported/,
			)

			void view.increment
			raw.increment = (() => 42) as typeof raw.increment
			expect(() => view.increment).toThrow(/plugin_caller_view_callable_field_unsupported/)
		})
	})

	it('keeps the dependency surface fixed to construction-time fields and prototype methods', async () => {
		await withCoreInternalTestHost(async (host) => {
			await host.start(CallerViewProvider)
			const raw = host.require(CallerViewProvider) as CallerViewProvider & { dynamic?: number }
			raw.addDynamicField()
			expect(raw.dynamic).toBe(1)

			host.add(CallerViewConsumer)
			await host.commit()

			const view = host.require(CallerViewConsumer).provider as CallerViewProvider & {
				dynamic?: number
			}
			expect(view.dynamic).toBeUndefined()
			expect(() => view.addDynamicField()).toThrow(TypeError)
			expect(raw.dynamic).toBe(1)
		})
	})

	it('keeps the generation ownership projection immutable on its Context', async () => {
		await withCoreInternalTestHost(async (host) => {
			await host.start(CallerViewProvider)
			const ctx = host.require(CallerViewProvider).ctx
			const pluginInfo = ctx.pluginInfo
			const mutable = ctx as unknown as { pluginInfo: unknown }

			expect(() => {
				mutable.pluginInfo = {}
			}).toThrow(TypeError)
			expect(() => Object.defineProperty(ctx, 'pluginInfo', { value: {} })).toThrow(TypeError)
			expect(Reflect.deleteProperty(ctx, 'pluginInfo')).toBe(false)
			expect(ctx.pluginInfo).toBe(pluginInfo)
		})
	})

	it('does not reuse views and rejects cached stale access after definition replacement', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()
			const oldRaw = host.require(CallerViewProvider)
			const oldView = host.require(CallerViewConsumer).provider
			const oldMethod = oldView.increment

			host.replace(CallerViewProvider, CallerViewProviderReplacement)
			await host.commit()
			const replacement = host.require(CallerViewProvider)
			const nextView = host.require(CallerViewConsumer).provider

			expect(replacement).toBeInstanceOf(CallerViewProviderReplacement)
			expect(replacement === oldRaw).toBe(false)
			expect(nextView === oldView).toBe(false)
			expect(() => oldView.value).toThrow(/owner stopped/i)
			expect(() => oldView.ctx).toThrow(/owner stopped/i)
			expect(() => {
				oldView.value = 1
			}).toThrow(/owner stopped/i)
			expect(() => oldMethod()).toThrow(/owner stopped/i)
			expect(nextView.increment()).toBe(1)
		})
	})

	it('keeps an admitted Promise getter alive through settlement while teardown waits', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()
			const consumer = host.require(CallerViewConsumer)
			const release = Promise.withResolvers<void>()
			getterWait = release.promise
			const invocation = consumer.provider.callerAfterGetter

			host.remove(CallerViewProvider)
			let committed = false
			const removal = (async (): Promise<void> => {
				await host.commit()
				committed = true
			})()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
			expect(committed).toBe(false)
			expect(providerCleanups).toBe(0)

			release.resolve()
			await expect(invocation).resolves.toBe(consumer.ctx)
			await removal
			expect(providerCleanups).toBe(1)
			expect(() => consumer.provider.callerAfterGetter).toThrow(/owner stopped/i)
		})
	})

	it('keeps a Promise-valued data field admitted through settlement', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()
			const raw = host.require(CallerViewProvider)
			const view = host.require(CallerViewConsumer).provider
			const release = Promise.withResolvers<void>()
			raw.promiseField = release.promise
			const observed = view.promiseField

			host.remove(CallerViewProvider)
			let committed = false
			const removal = (async (): Promise<void> => {
				await host.commit()
				committed = true
			})()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
			expect(committed).toBe(false)
			expect(providerCleanups).toBe(0)

			release.resolve()
			await observed
			await removal
			expect(providerCleanups).toBe(1)
		})
	})

	it('injects the replacement provider generation after an incremental consumer add', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add(CallerViewProvider)
			await host.commit()
			const firstProvider = host.require(CallerViewProvider)
			host.add(CallerViewConsumer)
			await host.commit()
			const firstConsumer = host.require(CallerViewConsumer)
			const firstView = firstConsumer.provider

			host.replace(CallerViewProvider, CallerViewProviderReplacement)
			await host.commit()

			const nextProvider = host.require(CallerViewProvider)
			const nextConsumer = host.require(CallerViewConsumer)
			expect(nextProvider === firstProvider).toBe(false)
			expect(nextConsumer === firstConsumer).toBe(false)
			expect(nextConsumer.provider === firstView).toBe(false)
			expect(nextProvider.ctx.pluginInfo.definitionRevision).toBe(2)
			expect(() => firstView.value).toThrow(/owner stopped/i)
			expect(nextConsumer.provider.increment()).toBe(1)
		})
	})

	it('keeps an admitted Promise method alive through settlement while teardown waits', async () => {
		await withCoreInternalTestHost(async (host) => {
			host.add([CallerViewProvider, CallerViewConsumer])
			await host.commit()
			const view = host.require(CallerViewConsumer).provider
			const cachedMethod = view.incrementAcross
			const release = Promise.withResolvers<void>()
			const invocation = cachedMethod(release.promise)

			host.remove(CallerViewProvider)
			let committed = false
			const removal = (async (): Promise<void> => {
				await host.commit()
				committed = true
			})()
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
			expect(committed).toBe(false)
			expect(providerCleanups).toBe(0)

			release.resolve()
			await expect(invocation).resolves.toBe(2)
			await removal
			expect(providerCleanups).toBe(1)
			expect(() => cachedMethod(Promise.resolve())).toThrow(/owner stopped/i)
		})
	})
})
