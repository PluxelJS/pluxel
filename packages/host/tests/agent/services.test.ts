import { expect, it, vi } from 'vitest'
import type { VaultKvTransaction } from '@pluxel/core/vault'
import { BasePlugin, Plugin, parsePluginNodeAddress, type Context } from '@pluxel/core'
import {
	createServiceRef,
	createServiceReference,
	readServiceDefinition,
	requirePluginService,
	setServiceControlContract,
} from '@pluxel/core/internal'
import { __defineServiceRef } from '@pluxel/core/toolchain'
import { installOwnerViewService, installRootService } from '@pluxel/core/host'
import { createHost, defineHostService } from '../../src'
import { createScriptScope } from '../../src/agent-runtime'

@Plugin()
class ServiceOwner extends BasePlugin {}

export abstract class CounterService {
	abstract count: number
	abstract add(delta: number): number
	abstract self(): CounterService
	abstract same(other: CounterService): boolean
}
export abstract class MissingService {
	abstract value: number
}
export abstract class BrokenService {
	abstract value: number
}
export class InstalledCounter extends CounterService {
	count = 0
	add(delta: number) {
		return (this.count += delta)
	}
	self() {
		return this
	}
	same(other: CounterService) {
		return this === other
	}
}
export abstract class OwnerService {
	static readonly access = 'owner'
	abstract owner: Context
	abstract serial: number
	abstract read(): number
}
export abstract class CallableService {
	abstract self(): CallableService
	abstract same(value: CallableService): boolean
}
export interface CallableService {
	(): Promise<string>
}
export abstract class AsyncOwnerService {
	static readonly access = 'owner'
	abstract hold(): Promise<string>
}

function counter(): CounterService {
	return {
		count: 0,
		add(delta) {
			return (this.count += delta)
		},
		self() {
			return this
		},
		same(other) {
			return this === other
		},
	}
}

it('uses one accessor for required and optional native declarations and preserves service receivers', async () => {
	const native = counter()
	const defect = new Error('service construction failed')
	await using host = await createHost({
		plugins: [],
		services: [
			defineHostService({
				name: 'counter',
				provides: [
					installRootService(CounterService, { create: () => native }),
					installRootService(BrokenService, {
						create: (): BrokenService => {
							throw defect
						},
					}),
				],
			}),
		],
	})
	await using scope = createScriptScope({ ctx: host.ctx })
	const ctx = scope.sdk.ctx
	const service = ctx.service(CounterService)
	expect(service).toBe(ctx.service(CounterService))
	expect(service).toBe(ctx.service(createServiceRef(CounterService)))
	expect(service.add(3)).toBe(3)
	expect(native.count).toBe(3)
	expect(service.self()).toBe(service)
	expect(service.same(service)).toBe(true)
	service.count = 7
	expect(native.count).toBe(7)
	expect(ctx.service(createServiceRef(MissingService))).toBeUndefined()
	expect(() => ctx.service(MissingService)).toThrow(
		expect.objectContaining({ code: 'CONTEXT_SERVICE_MISSING' }),
	)
	expect(() => ctx.service(createServiceRef(BrokenService))).toThrow(defect)
	expect(Reflect.ownKeys(ctx)).toContain('logger')
})

it('resolves verified required descriptors and optional refs by canonical identity before construction', async () => {
	const contract = `sha256:${'a'.repeat(64)}`
	let creations = 0
	await using host = await createHost({
		plugins: [],
		services: [
			defineHostService({
				name: 'canonical-counter',
				provides: [
					installRootService(InstalledCounter, {
						create: () => {
							creations++
							return new InstalledCounter()
						},
					}),
				],
			}),
		],
	})
	const definition = readServiceDefinition(InstalledCounter).definition!
	setServiceControlContract(InstalledCounter, contract)
	await using scope = createScriptScope({ ctx: host.ctx })
	const required = createServiceReference<CounterService, 'all'>({
		definition,
		access: 'all',
		contract,
	})
	const optional = __defineServiceRef<CounterService>({ format: 1, definition, contract })
	const mismatch = __defineServiceRef<CounterService>({
		format: 1,
		definition,
		contract: `sha256:${'b'.repeat(64)}`,
	})
	expect(() => scope.sdk.ctx.service(mismatch)).toThrow(
		expect.objectContaining({ code: 'control_contract_mismatch' }),
	)
	expect(creations).toBe(0)
	const service = scope.sdk.ctx.service(required)
	expect(service).toBe(scope.sdk.ctx.service(optional))
	expect(service.add(2)).toBe(2)
	expect(creations).toBe(1)
	const absent = { ...definition, exportName: 'Absent' }
	expect(
		scope.sdk.ctx.service(
			__defineServiceRef<CounterService>({ format: 1, definition: absent, contract }),
		),
	).toBeUndefined()
	expect(() =>
		scope.sdk.ctx.service(createServiceReference({ definition: absent, access: 'all', contract })),
	).toThrow(expect.objectContaining({ code: 'CONTEXT_SERVICE_MISSING' }))
	expect(() => scope.sdk.ctx.service({ ...required } as typeof required)).toThrow(TypeError)
})

it('borrows the current owner through an untyped node and rejects retained contexts after restart', async () => {
	let serial = 0
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
		services: [
			defineHostService({
				name: 'owner',
				provides: [
					installOwnerViewService(OwnerService, {
						createRoot: () => ({}),
						createView: (_backing, owner) => ({
							owner,
							serial: ++serial,
							read(this: OwnerService) {
								return this.serial
							},
						}),
					}),
				],
			}),
		],
	})
	await host.start()
	await using scope = createScriptScope({ ctx: host.ctx })
	const plugin = scope.sdk.plugin(parsePluginNodeAddress(ServiceOwner.nodeAddress()))
	await expect(plugin.context()).rejects.toMatchObject({ details: { code: 'plugin_not_running' } })
	await plugin.start()
	expect(() => scope.sdk.ctx.service(createServiceRef(OwnerService))).toThrow(
		expect.objectContaining({ code: 'CONTEXT_SERVICE_ACCESS_DENIED' }),
	)
	const first = await plugin.context()
	const service = first.service(OwnerService)
	const read = service.read
	expect(first).toBe(await plugin.context())
	expect(service.read()).toBe(1)
	await plugin.restart()
	expect(() => first.service(OwnerService)).toThrow('Plugin owner stopped')
	expect(() => service.serial).toThrow('Plugin owner stopped')
	expect(() => read.call(service)).toThrow('Plugin owner stopped')
	const second = await plugin.context()
	expect(second).not.toBe(first)
	expect(second.service(OwnerService).read()).toBe(2)
})

it('preserves callable services and drains accepted calls when the script closes', async () => {
	let finish!: (value: string) => void
	const pending = new Promise<string>((resolve) => {
		finish = resolve
	})
	const native: CallableService = Object.assign(() => pending, {
		self() {
			return native
		},
		same(value: CallableService) {
			return value === native
		},
	})
	let closed = false
	await using host = await createHost({
		plugins: [],
		services: [
			defineHostService({
				name: 'callable',
				provides: [installRootService(CallableService, { create: () => native })],
				prepare({ effects }) {
					effects.defer(() => {
						closed = true
					})
				},
			}),
		],
	})
	const scope = createScriptScope({ ctx: host.ctx })
	await using otherScope = createScriptScope({ ctx: host.ctx })
	const ctx = scope.sdk.ctx
	const service = ctx.service(CallableService)
	expect(service.self()).toBe(service)
	expect(service.same(service)).toBe(true)
	expect(Reflect.ownKeys(service)).toEqual(Reflect.ownKeys(native))
	const bound = service.bind(undefined)
	const rebound = service.bind.call(otherScope.sdk.ctx.service(CallableService), undefined)
	expect(rebound()).toBe(pending)
	const result = bound()
	expect(result).toBe(pending)
	let settled = false
	const closing = scope.dispose().then((): void => {
		settled = true
		return undefined
	})
	await Promise.resolve()
	expect(settled).toBe(false)
	expect(() => service()).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(() => bound()).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(() => ctx.service(CallableService)).toThrow(
		expect.objectContaining({ code: 'scope_closed' }),
	)
	finish('finished')
	expect(await result).toBe('finished')
	await closing
	await otherScope.dispose()
	expect(() => rebound()).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(closed).toBe(false)
	await host.close()
	expect(closed).toBe(true)
})

it('requires accepted owner service work to settle before queued Host operations', async () => {
	let finish!: (value: string) => void
	const pending = new Promise<string>((resolve) => {
		finish = resolve
	})
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
		services: [
			defineHostService({
				name: 'async-owner',
				provides: [
					installOwnerViewService(AsyncOwnerService, {
						createRoot: () => ({}),
						createView: () => ({ hold: () => pending }),
					}),
				],
			}),
		],
	})
	await host.start()
	await using scope = createScriptScope({ ctx: host.ctx })
	const plugin = scope.sdk.plugin(ServiceOwner.nodeAddress())
	await plugin.start()
	const context = await plugin.context()
	const service = context.service(AsyncOwnerService)
	const accepted = service.hold()
	try {
		await expect(plugin.restart()).rejects.toMatchObject({
			details: { code: 'borrowed_generation_conflict' },
		})
	} finally {
		finish('settled')
	}
	expect(await accepted).toBe('settled')
	await plugin.restart()
	expect(() => service.hold()).toThrow('Plugin owner stopped')
})

it('borrows Core built-ins directly and projects instance and owner Contexts onto the run', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const root = scope.sdk.ctx
	const plugin = scope.sdk.plugin(ServiceOwner.nodeAddress())
	await plugin.start()
	const context = await plugin.context()
	const { instance } = await plugin.instance()
	expect(root.root).toBe(root)
	expect(root.logging).toBeUndefined()
	expect(Object.prototype.toString.call(root)).toBe('[object PluxelContext]')
	expect(context.root).toBe(root)
	expect(context.pluginInfo.nodeAddress).toEqual(parsePluginNodeAddress(ServiceOwner.nodeAddress()))
	expect(instance.ctx).toBe(context)
	expect(Object.getOwnPropertyDescriptor(context, 'logger')?.enumerable).toBe(false)
	expect(Object.getOwnPropertyDescriptor(context, 'logger')?.get?.call(context)).toBe(
		context.logger,
	)
	expect(context.events.ctx).toBe(context)
	expect(context.logger).toBe(context.logger)
	root.logger.info('script root is available')
	const fs = await context.fs()
	await fs.writeFile('script.txt', 'script data')
	expect(await fs.readFile('script.txt', 'utf8')).toBe('script data')
	const store = await context.tinybase.open()
	store.setValue('script', 42)
	await context.tinybase.flush()
	expect(store.getValue('script')).toBe(42)
	const oldFs = context.fs
	const oldLogger = context.logger
	const oldInfo = oldLogger.info
	await plugin.restart()
	expect(() => oldFs()).toThrow('Plugin owner stopped')
	expect(() => Reflect.apply(oldInfo, oldLogger, ['stale'])).toThrow('Plugin owner stopped')
	expect(() => context.root).toThrow('Plugin owner stopped')
	expect(Object.prototype.toString.call(context)).toBe('[object PluxelContext]')
	const next = await plugin.context()
	expect(next).not.toBe(context)
	const nextEvents = next.events
	await scope.dispose()
	expect(() => root.name).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(() => nextEvents.ctx).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	expect(() => next.root).toThrow(expect.objectContaining({ code: 'scope_closed' }))
})

it('withdraws retained Vault KV, namespace, blob and subscription capabilities when their script closes', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
	})
	await host.startNode(ServiceOwner.nodeAddress())
	const scope = createScriptScope({ ctx: host.ctx })
	const context = await scope.sdk.plugin(ServiceOwner.nodeAddress()).context()
	const vault = context.vault
	expect(vault).toBe(context.vault)
	const kv = vault.kv()
	await kv.set('credential', { token: 'saved' })
	expect(await kv.get('credential')).toMatchObject({ value: { token: 'saved' } })
	const namespace = vault.namespace('script')
	const scopedKv = namespace.kv()
	await scopedKv.batch((tx) => tx.set('account/main', { token: 'scoped' }))
	const watched = await scopedKv.watch('account/main', () => {})
	const prefix = await scopedKv.watchPrefix('account/', () => {})
	expect(watched.snapshot.value).toEqual({ token: 'scoped' })
	expect(prefix.snapshots).toHaveLength(1)
	const blobs = namespace.blobs()
	const blob = blobs.open('certificate')
	await blob.writeText('certificate data')
	expect(await blob.readText()).toBe('certificate data')
	expect(blob.describe().path).toContain('certificate.blob')
	const get = scopedKv.get
	const dispose = watched.dispose
	await scope.dispose()
	for (const access of [
		() => vault.kv(),
		() => vault.flush(),
		() => namespace.name,
		() => namespace.kv(),
		() => kv.get('credential'),
		() => get('account/main'),
		() => blobs.open('another'),
		() => blob.describe(),
		() => blob.writeText('stale'),
		() => dispose(),
		() => prefix.dispose(),
	]) {
		expect(access).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	}
	const native = requirePluginService(host.ctx).getInstance(ServiceOwner.nodeAddress())!
	expect(await native.ctx.vault.kv().get('credential')).toMatchObject({
		value: { token: 'saved' },
	})
})

it('guards Vault transaction callbacks and retained transaction methods with the borrowing run', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
	})
	await host.startNode(ServiceOwner.nodeAddress())
	const scope = createScriptScope({ ctx: host.ctx })
	const context = await scope.sdk.plugin(ServiceOwner.nodeAddress()).context()
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let retained!: VaultKvTransaction
	const accepted = context.vault.kv().batch(async (tx) => {
		retained = tx
		tx.set('before-close', true)
		entered.resolve()
		await release.promise
		tx.set('after-close', true)
	})
	await entered.promise
	const settled = Promise.allSettled([accepted, scope.dispose()])
	let retainedFailure: unknown
	try {
		retained.get('before-close')
	} catch (error) {
		retainedFailure = error
	}
	release.resolve()
	const [operation, closing] = await settled
	expect(retainedFailure).toMatchObject({ code: 'scope_closed' })
	expect(operation).toMatchObject({
		status: 'rejected',
		reason: { code: 'scope_closed' },
	})
	expect(closing).toMatchObject({ status: 'rejected' })
	const native = requirePluginService(host.ctx).getInstance(ServiceOwner.nodeAddress())!
	expect(await native.ctx.vault.kv().get('before-close')).toMatchObject({ exists: false })
})

it('rejects a queued Vault batch callback after its borrowing run closes', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
	})
	await host.startNode(ServiceOwner.nodeAddress())
	const scope = createScriptScope({ ctx: host.ctx })
	const context = await scope.sdk.plugin(ServiceOwner.nodeAddress()).context()
	const native = requirePluginService(host.ctx).getInstance(ServiceOwner.nodeAddress())!
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const blocking = native.ctx.vault.kv().batch(async () => {
		entered.resolve()
		await release.promise
	})
	await entered.promise
	const callback = vi.fn(() => 'late callback')
	const accepted = context.vault.kv().batch(callback)
	const settled = Promise.allSettled([accepted, scope.dispose()])
	release.resolve()
	await blocking
	const [operation, closing] = await settled
	expect(operation).toMatchObject({
		status: 'rejected',
		reason: { code: 'scope_closed' },
	})
	expect(closing).toMatchObject({ status: 'rejected' })
	expect(callback).not.toHaveBeenCalled()
})

it('drains a Vault watch callback before releasing its script subscription', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
	})
	await host.startNode(ServiceOwner.nodeAddress())
	const scope = createScriptScope({ ctx: host.ctx })
	const context = await scope.sdk.plugin(ServiceOwner.nodeAddress()).context()
	const native = requirePluginService(host.ctx).getInstance(ServiceOwner.nodeAddress())!
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const listener = vi.fn(async () => {
		entered.resolve()
		await release.promise
	})
	const watched = await context.vault.kv().watch('watched', listener)
	await native.ctx.vault.kv().set('watched', 1)
	await entered.promise
	let closed = false
	const closing = scope.dispose().then((): void => {
		closed = true
		return undefined
	})
	await Promise.resolve()
	expect(closed).toBe(false)
	release.resolve()
	await closing
	expect(listener).toHaveBeenCalledTimes(1)
	expect(() => watched.dispose()).toThrow(expect.objectContaining({ code: 'scope_closed' }))
	await native.ctx.vault.kv().set('watched', 2)
	expect(listener).toHaveBeenCalledTimes(1)
})

it('borrows managed Fetch and native Wretch for both the plugin generation and script run', async () => {
	const callerEntered = Promise.withResolvers<AbortSignal>()
	const runEntered = Promise.withResolvers<AbortSignal>()
	const unawaitedEntered = Promise.withResolvers<AbortSignal>()
	const enteredByPath = new Map([
		['/caller', callerEntered],
		['/run', runEntered],
		['/unawaited', unawaitedEntered],
	])
	await using host = await createHost({
		plugins: [{ plugin: ServiceOwner }],
		coreConfig: {
			http: {
				async fetch(input, init) {
					const request = new Request(input, init)
					const entered = enteredByPath.get(new URL(request.url).pathname)
					if (!entered) return new Response(request.headers.get('x-plugin'))
					request.signal.throwIfAborted()
					return await new Promise<Response>((_resolve, reject) => {
						request.signal.addEventListener('abort', () => reject(request.signal.reason), {
							once: true,
						})
						entered.resolve(request.signal)
					})
				},
			},
		},
	})
	await host.start()
	await using scope = createScriptScope({ ctx: host.ctx })
	const plugin = scope.sdk.plugin(ServiceOwner.nodeAddress())
	await plugin.start()
	const first = await plugin.context()
	expect(first.wretch).toBe(first.wretch)
	expect('wretch' in scope.sdk.ctx).toBe(false)
	const native = first.wretch.url('https://example.test', true)
	await expect(native.headers({ 'X-Plugin': 'service' }).get('/test').text()).resolves.toBe(
		'service',
	)
	const staleFetch = first.fetch
	await plugin.restart()
	await expect(staleFetch('https://example.test/test')).rejects.toThrow('Plugin owner stopped')
	await expect(native.get('/test').text()).rejects.toThrow('Plugin owner stopped')

	const context = await plugin.context()
	const caller = new AbortController()
	const callerReason = new Error('caller cancelled')
	const callerResult = context
		.fetch(new Request('https://example.test/caller', { signal: caller.signal }))
		.catch((error: unknown) => error)
	await callerEntered.promise
	caller.abort(callerReason)
	expect(await callerResult).toBe(callerReason)

	const client = context.wretch.url('https://example.test', true)
	const pending = client
		.get('/run')
		.text()
		.catch((error: unknown) => error)
	void context.fetch('https://example.test/unawaited')
	const signals = await Promise.all([runEntered.promise, unawaitedEntered.promise])
	await scope.dispose()
	expect(await pending).toMatchObject({ name: 'AbortError' })
	expect(signals.every((signal) => signal.aborted)).toBe(true)
	await expect(client.get('/test').text()).rejects.toMatchObject({ code: 'scope_closed' })
	expect(requirePluginService(host.ctx).isRunning(ServiceOwner.nodeAddress())).toBe(true)
})

it('owns script effects in child scopes and leaves the borrowed root and generation running', async () => {
	await using host = await createHost({
		plugins: [
			{
				plugin: ServiceOwner,
			},
		],
	})
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const plugin = scope.sdk.plugin(ServiceOwner.nodeAddress())
	await plugin.start()
	const context = await plugin.context()
	const native = requirePluginService(host.ctx).getInstance(ServiceOwner.nodeAddress())!
	let rootClosed = false
	let generationClosed = false
	let rootReleased = false
	let ownerReleased = false
	host.ctx.effects.defer(() => {
		rootClosed = true
	})
	native.ctx.effects.defer(() => {
		generationClosed = true
	})
	scope.sdk.ctx.effects.defer(() => {
		rootReleased = true
	})
	context.effects.defer(() => {
		ownerReleased = true
	})
	await context.effects.dispose()
	expect(ownerReleased).toBe(true)
	expect(generationClosed).toBe(false)
	expect(rootReleased).toBe(false)
	expect(rootClosed).toBe(false)
	const status = await plugin.status()
	expect(status?.lifecycleState).toBe('running')
	await scope.dispose()
	expect(rootReleased).toBe(true)
	expect(generationClosed).toBe(false)
	expect(rootClosed).toBe(false)
	expect(requirePluginService(host.ctx).isRunning(ServiceOwner.nodeAddress())).toBe(true)
	await host.close()
	expect(generationClosed).toBe(true)
	expect(rootClosed).toBe(true)
})

it('settles an admitted acquisition before releasing its run-owned resource', async () => {
	await using host = await createHost({ plugins: [] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const gate = Promise.withResolvers<object>()
	const resource = {}
	let released: object | undefined
	const accepted = scope.sdk.ctx.effects.acquire(
		() => gate.promise,
		(value) => {
			released = value
		},
	)
	const closing = scope.dispose()
	const settled = Promise.allSettled([accepted, closing])
	gate.resolve(resource)
	expect(await settled).toEqual([
		{ status: 'fulfilled', value: resource },
		{ status: 'fulfilled', value: undefined },
	])
	expect(released).toBe(resource)
})

it('lets an admitted effects transaction finish registering resources before run cleanup', async () => {
	await using host = await createHost({ plugins: [] })
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	const gate = Promise.withResolvers<void>()
	const released: string[] = []
	const accepted = scope.sdk.ctx.effects.transaction(async (tx) => {
		tx.defer(() => {
			released.push('first')
		})
		await gate.promise
		expect(released).toEqual([])
		tx.defer(() => {
			released.push('second')
		})
		return 'settled'
	})
	const settled = Promise.allSettled([accepted, scope.dispose()])
	gate.resolve()
	expect(await settled).toEqual([
		{ status: 'fulfilled', value: 'settled' },
		{ status: 'fulfilled', value: undefined },
	])
	expect(released).toEqual(['second', 'first'])
})

it('releases run effects after accepted work fails and preserves both failures', async () => {
	const host = await createHost({ plugins: [] })
	await host.start()
	try {
		const scope = createScriptScope({ ctx: host.ctx })
		const gate = Promise.withResolvers<object>()
		const workFailure = new Error('acquisition failed')
		const cleanupFailure = new Error('cleanup failed')
		let released = false
		const effects = scope.sdk.ctx.effects
		effects.defer(() => {
			released = true
			throw cleanupFailure
		})
		const accepted = effects.acquire(
			() => gate.promise,
			() => {},
		)
		const settled = Promise.allSettled([accepted, scope.dispose()])
		gate.reject(workFailure)
		const [work, closing] = await settled
		expect(work).toEqual({ status: 'rejected', reason: workFailure })
		expect(released).toBe(true)
		expect(closing).toEqual({
			status: 'rejected',
			reason: expect.objectContaining({
				errors: [workFailure, expect.objectContaining({ errors: [cleanupFailure] })],
			}),
		})
	} finally {
		// The parent scope retains the child's cleanup failure for Host shutdown too.
		await expect(host.close()).rejects.toBeInstanceOf(AggregateError)
	}
})
