import { BasePlugin, Plugin } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { createHost } from '../src'
import { requirePluginHostCoordinator, setHostCatalogProvenance } from '../src/internal'
import { createScriptScope, type PluginDescriptor } from '../src/agent'

const configHash = `sha256:${'a'.repeat(64)}`
const instanceHash = `sha256:${'b'.repeat(64)}`
const wrongHash = `sha256:${'c'.repeat(64)}`
const schema = {
	'~standard': {
		version: 1 as const,
		vendor: 'agent-control-test',
		types: undefined as { input: { count?: number }; output: { count: number } } | undefined,
		validate(input: unknown) {
			const count = (input as { count?: unknown })?.count ?? 2
			return typeof count === 'number'
				? { value: { count } }
				: { issues: [{ message: 'Expected count', path: ['count'] }] }
		},
	},
}
let cleanups = 0
let thenReads = 0
@Plugin({ forkable: true })
class Counter extends BasePlugin {
	readonly config = this.configs.use(schema)
	count = 2
	private secret = 7
	readonly described = Object.assign(
		function described(this: Counter, delta: number) {
			return this.count + delta
		},
		{ description: 'counter plus delta' },
	)
	init() {
		return () => {
			cleanups++
		}
	}
	add(delta: number) {
		return (this.count += delta)
	}
	privateValue() {
		return this.secret
	}
	same(other: Counter) {
		return this === other && this.secret === other.secret
	}
	self(): this {
		return this
	}
	// Business then accessors must stay unprobed when borrowing the instance.
	// eslint-disable-next-line unicorn/no-thenable
	get then(): unknown {
		thenReads++
		return undefined
	}
	async after(gate: Promise<void>) {
		await gate
		return this.count
	}
	async callback(work: () => Promise<unknown>) {
		return await work()
	}
	returnValue<T>(value: T): T {
		return value
	}
}
let CounterDescriptor: PluginDescriptor<{ count?: number }, { count: number }, Counter>

async function setup() {
	CounterDescriptor = {
		format: 1,
		definition: Counter.definitionAddress(),
		contracts: { config: configHash, instance: instanceHash },
	} as typeof CounterDescriptor
	const host = await createHost({
		plugins: [Counter],
		runtime: { documents: { state: false, config: false } },
	})
	setHostCatalogProvenance(
		host.ctx,
		new Map([
			[
				Counter,
				{
					control: {
						state: 'available',
						format: 1,
						contracts: { config: configHash, instance: instanceHash },
					},
				},
			],
		]),
	)
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	await scope.sdk.plugins.start(Counter.nodeAddress())
	return { host, scope }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

it('checks only the contract used by an operation, preserving original config and status results', async () => {
	const { host, scope } = await setup()
	try {
		const wrongInstance = {
			...CounterDescriptor,
			contracts: { config: configHash, instance: wrongHash },
		}
		expect(await scope.sdk.config.get(wrongInstance)).toMatchObject({
			ok: true,
			config: { count: 2 },
		})
		await expect(scope.sdk.plugins.instance(wrongInstance)).rejects.toMatchObject({
			code: 'control_contract_mismatch',
		})
		const wrongConfig = {
			...CounterDescriptor,
			contracts: { config: wrongHash, instance: instanceHash },
		}
		await expect(scope.sdk.config.patch(wrongConfig, { set: { count: 8 } })).rejects.toMatchObject({
			code: 'control_contract_mismatch',
		})
		expect(await scope.sdk.plugins.status(wrongConfig)).toMatchObject({ lifecycleState: 'running' })
		expect(await scope.sdk.config.get(CounterDescriptor)).toMatchObject({ config: { count: 2 } })
		const borrowed = await scope.sdk.plugins.instance(wrongConfig)
		expect(borrowed.instance.count).toBe(2)
		const preview = await scope.sdk.config.validate(CounterDescriptor, { set: { count: 9 } })
		expect(preview).toMatchObject({
			ok: true,
			config: { count: 9 },
			persistence: { status: 'unchanged' },
		})
		expect(await scope.sdk.config.get(CounterDescriptor)).toMatchObject({ config: { count: 2 } })
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('reports committed control preparation failures through ordinary SDK status issues without disabling the Plugin', async () => {
	const { host, scope } = await setup()
	try {
		for (const reason of ['analysis_failed', 'source_changed', 'missing'] as const) {
			const message = `control ${reason}: fixture input cannot be represented`
			const previousStatus = await scope.sdk.plugins.status(CounterDescriptor)
			setHostCatalogProvenance(
				host.ctx,
				new Map([[Counter, { control: { state: 'unavailable', reason, message } }]]),
			)
			expect(await scope.sdk.plugins.status(CounterDescriptor)).toEqual(previousStatus)
			await host.updateCatalog([Counter])
			const status = await scope.sdk.plugins.status(CounterDescriptor)
			expect(status).toMatchObject({ availability: 'available', lifecycleState: 'running' })
			const issue = {
				id: expect.stringContaining(`:${reason}`),
				code: `control_${reason}`,
				message,
			}
			expect(status?.issues).toEqual(reason === 'missing' ? [] : [issue])
			const plugins = await scope.sdk.plugins.list()
			expect(
				plugins.find((entry) => entry.address.definition.exportName === 'Counter')?.issues,
			).toEqual(status?.issues)
		}
		setHostCatalogProvenance(
			host.ctx,
			new Map([
				[
					Counter,
					{
						control: {
							state: 'available',
							format: 1,
							contracts: { config: configHash, instance: instanceHash },
						},
					},
				],
			]),
		)
		await host.updateCatalog([Counter])
		expect(await scope.sdk.plugins.status(CounterDescriptor)).toMatchObject({
			availability: 'available',
			lifecycleState: 'running',
			issues: [],
		})
		const borrowed = await scope.sdk.plugins.instance(CounterDescriptor)
		expect(borrowed.instance.count).toBe(2)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('admits actual instance members, preserves JavaScript receivers and never probes business then', async () => {
	const { host, scope } = await setup()
	try {
		thenReads = 0
		const { instance } = await scope.sdk.plugins.instance(CounterDescriptor)
		const raw = requirePluginService(host.ctx).getInstance(Counter.nodeAddress())
		expect(instance).not.toBe(raw)
		expect(thenReads).toBe(0)
		expect(instance.self()).toBe(instance)
		expect(thenReads).toBe(0)
		expect(instance.privateValue()).toBe(7)
		expect(instance.same(instance)).toBe(true)
		expect(instance.described.description).toBe('counter plus delta')
		expect(instance.described.name).toBe('described')
		expect(instance.described.length).toBe(1)
		expect(instance.described(3)).toBe(5)
		expect(instance.add(3)).toBe(5)
		const extracted = instance.add
		expect(() => extracted(1)).toThrow(TypeError)
		expect(extracted.call({ count: 10 } as Counter, 2)).toBe(12)
		const ordinary = {
			// Accessing a returned object's business then must not run its getter.
			// eslint-disable-next-line unicorn/no-thenable
			get then() {
				thenReads++
				throw new Error('must not probe')
			},
		}
		expect(instance.returnValue(ordinary)).toBe(ordinary)
		expect(thenReads).toBe(0)
		instance.count = 11
		expect(raw).toMatchObject({ count: 11 })
		await scope.dispose()
		expect(() => instance.add(1)).toThrow(/closing or closed/)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('checks typed configuration against the catalog actually admitted on the original transaction queue', async () => {
	const { host, scope } = await setup()
	try {
		const gate = Promise.withResolvers<void>()
		const barrier = requirePluginHostCoordinator(host.ctx).runExclusive(
			'control-test-barrier',
			() => gate.promise,
		)
		setHostCatalogProvenance(
			host.ctx,
			new Map([
				[
					Counter,
					{
						control: {
							state: 'available',
							format: 1,
							contracts: { config: wrongHash, instance: instanceHash },
						},
					},
				],
			]),
		)
		const replacement = host.updateCatalog([Counter])
		await tick()
		const mutation = scope.sdk.config.patch(CounterDescriptor, { set: { count: 100 } })
		const rejected = mutation.then(
			() => {
				throw new Error('Expected the queued mutation to reject its stale control contract')
			},
			(error: unknown) => error,
		)
		gate.resolve()
		await barrier
		await replacement
		await expect(rejected).resolves.toMatchObject({ code: 'control_contract_mismatch' })
		expect(await scope.sdk.config.get(Counter.nodeAddress())).toMatchObject({
			config: { count: 2 },
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('preserves native Promise subclasses and leaves lazy business thenables untouched', async () => {
	const { host, scope } = await setup()
	try {
		const { instance } = await scope.sdk.plugins.instance(CounterDescriptor)
		let calls = 0
		const lazy = {
			// Admission must preserve a lazy business thenable without invoking it.
			// eslint-disable-next-line unicorn/no-thenable
			then() {
				calls++
			},
		}
		expect(instance.returnValue(lazy)).toBe(lazy)
		expect(calls).toBe(0)
		class NativeResult extends Promise<number> {}
		let resolve!: (value: number) => void
		const native = new NativeResult((done) => {
			resolve = done
		})
		expect(instance.returnValue(native)).toBe(native)
		await expect(scope.sdk.config.get(CounterDescriptor)).rejects.toMatchObject({
			code: 'borrowed_generation_conflict',
		})
		resolve(9)
		expect(await native).toBe(9)
		const foreign = runInNewContext('Promise.resolve(13)') as Promise<number>
		expect(instance.returnValue(foreign)).toBe(foreign)
		expect(await foreign).toBe(13)
		expect(await scope.sdk.config.get(CounterDescriptor)).toMatchObject({ ok: true })
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('reports unsupported native Promise species without silently accepting or leaking an admission', async () => {
	const { host, scope } = await setup()
	let settle!: () => void
	try {
		const { instance } = await scope.sdk.plugins.instance(CounterDescriptor)
		const failure = new Error('custom species cannot create a reaction')
		class BrokenResult extends Promise<void> {
			static get [Symbol.species](): PromiseConstructor {
				throw failure
			}
		}
		const original = new BrokenResult((resolve) => {
			settle = resolve
		})
		expect(() => instance.returnValue(original)).toThrow(failure)
		expect(await scope.sdk.config.get(CounterDescriptor)).toMatchObject({ ok: true })
		settle()
		await scope.dispose()
	} finally {
		settle?.()
		await scope.dispose()
		await host.close()
	}
})

it('rejects Promise.all queue/member cycles without leaving the provider admitted', async () => {
	const { host, scope } = await setup()
	const gate = Promise.withResolvers<void>()
	try {
		const { instance } = await scope.sdk.plugins.instance(CounterDescriptor)
		const management = scope.sdk.config.get(CounterDescriptor)
		const business = instance.after(gate.promise)
		await expect(Promise.all([management, business])).rejects.toMatchObject({
			code: 'borrowed_generation_conflict',
		})
		gate.resolve()
		await business
		expect(await scope.sdk.config.get(CounterDescriptor)).toMatchObject({ ok: true })
	} finally {
		gate.resolve()
		await scope.dispose()
		await host.close()
	}
})

it('holds provider cleanup until a native Promise settles and rejects cyclic queued operations', async () => {
	const { host, scope } = await setup()
	try {
		cleanups = 0
		const { instance } = await scope.sdk.plugins.instance(CounterDescriptor)
		const gate = Promise.withResolvers<void>()
		const pending = instance.after(gate.promise)
		await expect(scope.sdk.config.get(CounterDescriptor)).rejects.toMatchObject({
			code: 'borrowed_generation_conflict',
		})
		await expect(scope.sdk.plugins.restart(CounterDescriptor)).rejects.toMatchObject({
			code: 'borrowed_generation_conflict',
		})
		const otherScope = createScriptScope({ ctx: host.ctx })
		let restarted = false
		const restart = otherScope.sdk.plugins.restart(CounterDescriptor).then((): void => {
			restarted = true
			return undefined
		})
		await tick()
		expect(restarted).toBe(false)
		expect(cleanups).toBe(0)
		gate.resolve()
		await pending
		await restart
		expect(cleanups).toBe(1)
		expect(() => instance.add(1)).toThrow(/owner stopped/i)
		const next = await scope.sdk.plugins.instance(CounterDescriptor)
		expect(next.instance.add(1)).toBe(3)
		await otherScope.dispose()
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('rejects member admission behind an already queued Host read instead of deadlocking a waiting restart', async () => {
	const { host, scope } = await setup()
	const otherScope = createScriptScope({ ctx: host.ctx })
	const gate = Promise.withResolvers<void>()
	try {
		const { instance } = await scope.sdk.plugins.instance(CounterDescriptor)
		const barrier = requirePluginHostCoordinator(host.ctx).runExclusive(
			'reverse-cycle-barrier',
			() => gate.promise,
		)
		const restart = otherScope.sdk.plugins.restart(CounterDescriptor)
		await tick()
		const management = scope.sdk.config.get(CounterDescriptor)
		await tick()
		expect(() => instance.after(management.then((): void => undefined))).toThrow(
			/Await pending Host operations/,
		)
		gate.resolve()
		await barrier
		await restart
		expect(await management).toMatchObject({ ok: true })
	} finally {
		gate.resolve()
		await scope.dispose()
		await otherScope.dispose()
		await host.close()
	}
})

it('rejects a member callback queued read and drains unawaited native Promise members on scope close', async () => {
	const { host, scope } = await setup()
	try {
		const { instance } = await scope.sdk.plugins.instance(CounterDescriptor)
		await expect(
			instance.callback(() => scope.sdk.config.get(CounterDescriptor)),
		).rejects.toMatchObject({ code: 'borrowed_generation_conflict' })
		const gate = Promise.withResolvers<void>()
		const result = instance.after(gate.promise)
		let disposed = false
		const disposal = scope.dispose().then((): void => {
			disposed = true
			return undefined
		})
		await tick()
		expect(disposed).toBe(false)
		gate.resolve()
		await result
		await disposal
		expect(disposed).toBe(true)
	} finally {
		await scope.dispose()
		await host.close()
	}
})
