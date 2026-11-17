import { expect, it } from 'vitest'
import { BasePlugin, Plugin, parsePluginNodeAddress, type Context } from '@pluxel/core'
import {
	createServiceRef,
	createServiceReference,
	readServiceDefinition,
	setServiceControlContract,
} from '@pluxel/core/internal'
import { __defineServiceRef } from '@pluxel/core/toolchain'
import { installOwnerViewService, installRootService } from '@pluxel/core/host'
import { createHost, defineHostService } from '../src'
import { createScriptScope } from '../src/agent-runtime'

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
	expect(Object.keys(ctx)).toEqual(['service'])
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
		plugins: [ServiceOwner],
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
		plugins: [ServiceOwner],
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
