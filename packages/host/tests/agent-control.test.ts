import { BasePlugin, Plugin, parsePluginNodeAddress, type PluginNodeAddress } from '@pluxel/core'
import { CorePluginGraphVerificationError, requirePluginService } from '@pluxel/core/internal'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { createHost, HostStatePersistenceError, PluginGraphRejectedError } from '../src'
import { requirePluginHostCoordinator, setHostCatalogProvenance } from '../src/internal'
import type { PluginDescriptor } from '../src/agent'
import { createScriptScope, ScriptError } from '../src/agent-runtime'
import { createPluginControlReference } from '../src/control-reference'
import { PluginControlError } from '../src/catalog'

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
	CounterDescriptor = createPluginControlReference({
		format: 2,
		definition: Counter.address(),
		contracts: { config: configHash, instance: instanceHash },
	}) as unknown as typeof CounterDescriptor
	const host = await createHost({
		plugins: [
			{
				plugin: Counter,
			},
		],
		policy: {
			document: false,
		},
		config: {
			document: false,
		},
	})
	setHostCatalogProvenance(
		host.ctx,
		new Map([
			[
				Counter,
				{
					control: {
						state: 'available',
						format: 2,
						contracts: { config: configHash, instance: instanceHash },
					},
				},
			],
		]),
	)
	await host.start()
	const scope = createScriptScope({ ctx: host.ctx })
	await scope.sdk.plugin(Counter.nodeAddress()).start()
	return { host, scope }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

it('keeps JSON identities dynamic and refuses copied typed address evidence', async () => {
	const { host, scope } = await setup()
	try {
		const address = CounterDescriptor.nodeAddress()
		for (const copied of [{ ...address }, Object.assign({}, address)])
			expect(() => scope.sdk.plugin(copied)).toThrow('copied or detached')
		const serialized = JSON.parse(JSON.stringify(address)) as typeof address
		const dynamic = scope.sdk.plugin(serialized)
		await expect(dynamic.instance()).rejects.toMatchObject({
			details: { code: 'control_evidence_missing' },
		})
		expect(await dynamic.config.get()).toMatchObject({ config: { count: 2 } })
		const { instance: original } = await scope.sdk.plugin(address).instance()
		const selected = scope.sdk.plugin(address)
		expect(selected.address).toBe(address)
		const { instance: reselected } = await scope.sdk.plugin(selected.address).instance()
		expect(reselected).toBe(original)
		expect(original.add(1)).toBe(3)
		const snapshot = await scope.sdk.plugins.list()
		expect(snapshot).toMatchObject({
			catalogRevision: expect.any(Number),
			runtimeStateRevision: expect.any(Number),
			nodes: expect.arrayContaining([expect.objectContaining({ lifecycleState: 'running' })]),
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('retains config behavior and control checks after ordinary address type erasure', async () => {
	const { host, scope } = await setup()
	try {
		const sourceAddress: PluginNodeAddress = Counter.nodeAddress()
		expect(await scope.sdk.plugin(sourceAddress).config.get()).toMatchObject({
			config: { count: 2 },
		})
		const controlAddress: PluginNodeAddress = CounterDescriptor.nodeAddress()
		expect(await scope.sdk.plugin(controlAddress).config.get()).toMatchObject({
			config: { count: 2 },
		})
		const changed = createPluginControlReference({
			format: 2,
			definition: Counter.address(),
			contracts: { config: wrongHash, instance: instanceHash },
		})
		const changedAddress: PluginNodeAddress = changed.nodeAddress()
		await expect(scope.sdk.plugin(changedAddress).config.get()).rejects.toMatchObject({
			details: { code: 'control_contract_mismatch' },
		})
		await expect(
			scope.sdk.plugin(scope.sdk.plugin(changedAddress).address).config.get(),
		).rejects.toMatchObject({
			details: { code: 'control_contract_mismatch' },
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('selects immutable targets and replaces forks without materializing nodes or borrowing method receivers', async () => {
	const { host, scope } = await setup()
	try {
		const { plugin } = scope.sdk
		const before = await scope.sdk.plugins.list()
		const descriptorData = {
			format: 2 as const,
			definition: {
				...Counter.address(),
				entry: { ...Counter.address().entry },
			},
			contracts: { config: configHash, instance: instanceHash },
		}
		const descriptor = createPluginControlReference(
			descriptorData,
		) as unknown as typeof CounterDescriptor
		const { nodeAddress } = descriptor
		const selected = plugin(nodeAddress('east'))
		const { config, status, start, stop, instance } = selected
		const west = plugin(nodeAddress('west'))
		const dynamicAddress = {
			...parsePluginNodeAddress(Counter.nodeAddress()),
			definition: { ...Counter.address() },
		}
		const dynamic = plugin(dynamicAddress)
		descriptorData.definition.exportName = 'Changed'
		if (descriptorData.definition.entry.kind === 'source-entry')
			descriptorData.definition.entry.path = 'changed.ts'
		else descriptorData.definition.entry.packageName = 'changed-package'
		descriptorData.contracts.config = wrongHash
		descriptorData.contracts.instance = wrongHash
		dynamicAddress.definition.exportName = 'Changed'
		expect(parsePluginNodeAddress(selected.address)).toEqual(
			parsePluginNodeAddress(Counter.nodeAddress('east')),
		)
		expect(parsePluginNodeAddress(west.address)).toEqual(
			parsePluginNodeAddress(Counter.nodeAddress('west')),
		)
		expect(dynamic.address).toEqual(parsePluginNodeAddress(Counter.nodeAddress()))
		expect(Object.isFrozen(dynamic.address)).toBe(true)
		expect(Object.isFrozen(dynamic.address.definition)).toBe(true)
		expect(await scope.sdk.plugins.list()).toEqual(before)
		expect(requirePluginService(host.ctx).isRunning(Counter.nodeAddress('east'))).toBe(false)
		expect(requirePluginService(host.ctx).isRunning(Counter.nodeAddress('west'))).toBe(false)
		expect(await host.forks.ensure(Counter.nodeAddress('east'))).toMatchObject({ ok: true })
		await start()
		expect(await status()).toMatchObject({ lifecycleState: 'running' })
		const { instance: borrowed } = await instance()
		expect(borrowed.count).toBe(2)
		const { get, validate, patch, reset } = config
		expect(await get()).toMatchObject({ config: { count: 2 } })
		expect(await validate({ set: { count: 5 } })).toMatchObject({
			config: { count: 5 },
		})
		expect(await patch({ set: { count: 8 } })).toMatchObject({
			config: { count: 8 },
		})
		expect(await get()).toMatchObject({ config: { count: 8 } })
		expect(await dynamic.config.get()).toMatchObject({ config: { count: 2 } })
		expect(await reset()).toMatchObject({ config: { count: 2 } })
		await stop()
		expect(await status()).toMatchObject({ lifecycleState: 'stopped' })
		expect(requirePluginService(host.ctx).isRunning(Counter.nodeAddress())).toBe(true)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('refreshes a current generation through the same ref and closes cached selectors and methods with their scope', async () => {
	const { host, scope } = await setup()
	try {
		const { plugin } = scope.sdk
		const ref = plugin(CounterDescriptor.nodeAddress())
		const { status, start, stop, restart, instance, config } = ref
		const { get, validate, patch, reset } = config
		const { instance: first } = await instance()
		expect(first.add(10)).toBe(12)
		await restart()
		expect(() => first.add(1)).toThrow(/owner stopped/i)
		const { instance: current } = await instance()
		expect(Object.is(current, first)).toBe(false)
		expect(current.add(1)).toBe(3)
		await scope.dispose()
		expect(() => plugin(CounterDescriptor.nodeAddress())).toThrow(/closing or closed/)
		expect(() => plugin(CounterDescriptor.nodeAddress('east'))).toThrow(/closing or closed/)
		const calls: (() => Promise<unknown>)[] = [
			status,
			start,
			stop,
			restart,
			instance,
			get,
			() => validate({ set: { count: 9 } }),
			() => patch({ set: { count: 9 } }),
			reset,
		]
		for (const call of calls)
			await expect(call()).rejects.toMatchObject({
				details: { code: 'scope_closed' },
			})
		expect(() => current.add(1)).toThrow(/closing or closed/)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('drains an admitted expected failure without reporting a second cleanup rejection', async () => {
	const { host, scope } = await setup()
	try {
		const accepted = scope.sdk.plugins.list()
		const disposal = scope.dispose()
		await expect(accepted).rejects.toMatchObject({
			details: { code: 'scope_closed' },
		})
		await expect(disposal).resolves.toBeUndefined()
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it.each([
	new Error('cancel this mutation'),
	new ScriptError({
		code: 'persistence_failed',
		state: 'unknown',
		message: 'cancel this mutation',
	}),
])(
	'classifies operation cancellation before its reason class (%s) without changing Host state',
	async (reason) => {
		const { host, scope } = await setup()
		try {
			const selected = scope.sdk.plugin(CounterDescriptor.nodeAddress())
			const before = await selected.config.get()
			const policyBefore = await scope.sdk.policy.get()
			const signal = AbortSignal.abort(reason)
			for (const operation of [
				() => selected.config.patch({ set: { count: 99 } }, { signal }),
				() => selected.config.reset(undefined, { signal }),
				() => scope.sdk.policy.patch({ startConcurrency: 2 }, { signal }),
				() => scope.sdk.policy.reset(undefined, { signal }),
			])
				await expect(operation()).rejects.toMatchObject({
					details: { code: 'cancelled' },
				})
			const after = await selected.config.get()
			expect(after.config).toEqual(before.config)
			expect(after.managedRevision).toBe(before.managedRevision)
			expect(await scope.sdk.policy.get()).toEqual(policyBefore)
		} finally {
			await scope.dispose()
			await host.close()
		}
	},
)

it('classifies a queued cancellation by signal identity before a known control error and drains cleanly', async () => {
	const { host, scope } = await setup()
	const coordinator = requirePluginHostCoordinator(host.ctx)
	const gate = Promise.withResolvers<void>()
	const blocker = coordinator.runExclusive('cancel-control-blocker', () => gate.promise)
	const enqueued = vi.spyOn(coordinator, 'runExclusive')
	try {
		const { get } = scope.sdk.plugin(CounterDescriptor.nodeAddress()).config
		const accepted = get()
		await Promise.resolve()
		expect(enqueued).toHaveBeenCalledWith(
			'plugin-config-read',
			expect.any(Function),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)
		scope.abort(new PluginControlError('control_contract_mismatch', 'cancel the waiting read'))
		const disposal = scope.dispose()
		gate.resolve()
		await blocker
		await expect(accepted).rejects.toMatchObject({
			details: { code: 'cancelled' },
		})
		await expect(disposal).resolves.toBeUndefined()
		await expect(get()).rejects.toMatchObject({
			details: { code: 'scope_closed' },
		})
	} finally {
		gate.resolve()
		enqueued.mockRestore()
		await blocker
		await scope.dispose()
		await host.close()
	}
})

it.each(['validate', 'patch', 'reset'] as const)(
	'cancels a queued policy %s with a persistence-shaped reason without changing managed policy',
	async (operation) => {
		const { host, scope } = await setup()
		const gate = Promise.withResolvers<void>()
		let blocker: Promise<unknown> | undefined
		let restore: (() => void) | undefined
		try {
			const before = await scope.sdk.policy.patch({ startTimeoutMs: 4000 })
			const coordinator = requirePluginHostCoordinator(host.ctx)
			blocker = coordinator.runExclusive('cancel-policy-blocker', () => gate.promise)
			const enqueued =
				operation === 'validate'
					? vi.spyOn(coordinator, 'readCommitted')
					: vi.spyOn(coordinator, 'runExclusive')
			restore = () => enqueued.mockRestore()
			const accepted =
				operation === 'reset'
					? scope.sdk.policy.reset(['startTimeoutMs'])
					: scope.sdk.policy[operation]({ startTimeoutMs: 8000 })
			await Promise.resolve()
			expect(enqueued).toHaveBeenCalledTimes(1)
			scope.abort(new HostStatePersistenceError(new Error('cancel the waiting policy operation')))
			const disposal = scope.dispose()
			gate.resolve()
			await blocker
			await expect(accepted).rejects.toMatchObject({
				details: { code: 'cancelled' },
			})
			await expect(disposal).resolves.toBeUndefined()
			expect(await host.policy.get()).toMatchObject({
				ok: true,
				managedInput: before.managedInput,
				managedRevision: before.managedRevision,
			})
		} finally {
			gate.resolve()
			restore?.()
			await blocker
			await scope.dispose()
			await host.close()
		}
	},
)

it('retains a known Core graph rejection cause in the lifecycle error without replacing the generation', async () => {
	const { host, scope } = await setup()
	const coordinator = requirePluginHostCoordinator(host.ctx)
	const detail = 'Required dependency cycle: Counter -> Provider -> Counter'
	const cause = new CorePluginGraphVerificationError(
		Object.assign(new Error('graph build failed'), {
			issues: [{ kind: 'CircularDependency' as const, chain: [Counter, Counter] }],
			format: () => detail,
		}),
	)
	const rejected = new PluginGraphRejectedError([], cause)
	const failure = vi.spyOn(coordinator, 'restartNode').mockRejectedValueOnce(rejected)
	try {
		const original = requirePluginService(host.ctx).getInstance(Counter.nodeAddress())
		await expect(scope.sdk.plugin(CounterDescriptor.nodeAddress()).restart()).rejects.toMatchObject(
			{
				details: {
					code: 'graph_rejected',
					state: 'unchanged',
					issues: [],
					message: expect.stringContaining(detail),
				},
			},
		)
		expect(requirePluginService(host.ctx).getInstance(Counter.nodeAddress())).toBe(original)
	} finally {
		failure.mockRestore()
		await scope.dispose()
		await host.close()
	}
})

it('checks only the contract used by an operation, preserving original config and status results', async () => {
	const { host, scope } = await setup()
	try {
		const wrongInstance = createPluginControlReference({
			format: 2,
			definition: Counter.address(),
			contracts: { config: configHash, instance: wrongHash },
		}) as unknown as typeof CounterDescriptor
		expect(await scope.sdk.plugin(wrongInstance.nodeAddress()).config.get()).toMatchObject({
			config: { count: 2 },
		})
		await expect(scope.sdk.plugin(wrongInstance.nodeAddress()).instance()).rejects.toMatchObject({
			details: { code: 'control_contract_mismatch' },
		})
		const wrongConfig = createPluginControlReference({
			format: 2,
			definition: Counter.address(),
			contracts: { config: wrongHash, instance: instanceHash },
		}) as unknown as typeof CounterDescriptor
		await expect(
			scope.sdk.plugin(wrongConfig.nodeAddress()).config.patch({ set: { count: 8 } }),
		).rejects.toMatchObject({ details: { code: 'control_contract_mismatch' } })
		expect(await scope.sdk.plugin(wrongConfig.nodeAddress()).status()).toMatchObject({
			lifecycleState: 'running',
		})
		expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()).toMatchObject({
			config: { count: 2 },
		})
		const { instance: borrowed } = await scope.sdk.plugin(wrongConfig.nodeAddress()).instance()
		expect(borrowed.count).toBe(2)
		const preview = await scope.sdk
			.plugin(CounterDescriptor.nodeAddress())
			.config.validate({ set: { count: 9 } })
		expect(preview).toMatchObject({
			config: { count: 9 },
			persistence: { status: 'unchanged' },
		})
		expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()).toMatchObject({
			config: { count: 2 },
		})
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
			const previousStatus = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).status()
			setHostCatalogProvenance(
				host.ctx,
				new Map([[Counter, { control: { state: 'unavailable', reason, message } }]]),
			)
			expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).status()).toEqual(
				previousStatus,
			)
			await host.updateCatalog([Counter])
			const status = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).status()
			expect(status).toMatchObject({ availability: 'available', lifecycleState: 'running' })
			const issue = {
				id: expect.stringContaining(`:${reason}`),
				code: `control_${reason}`,
				message,
			}
			expect(status?.issues).toEqual(reason === 'missing' ? [] : [issue])
			const plugins = await scope.sdk.plugins.list()
			expect(
				plugins.nodes.find((entry) => entry.address.definition.exportName === 'Counter')?.issues,
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
							format: 2,
							contracts: { config: configHash, instance: instanceHash },
						},
					},
				],
			]),
		)
		await host.updateCatalog([Counter])
		expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).status()).toMatchObject({
			availability: 'available',
			lifecycleState: 'running',
			issues: [],
		})
		const { instance: borrowed } = await scope.sdk
			.plugin(CounterDescriptor.nodeAddress())
			.instance()
		expect(borrowed.count).toBe(2)
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('admits actual instance members, preserves JavaScript receivers and never probes business then', async () => {
	const { host, scope } = await setup()
	try {
		thenReads = 0
		const { instance } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
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
							format: 2,
							contracts: { config: wrongHash, instance: instanceHash },
						},
					},
				],
			]),
		)
		const replacement = host.updateCatalog([Counter])
		await tick()
		const mutation = scope.sdk
			.plugin(CounterDescriptor.nodeAddress())
			.config.patch({ set: { count: 100 } })
		gate.resolve()
		await barrier
		await replacement
		await expect(mutation).rejects.toMatchObject({
			details: { code: 'control_contract_mismatch' },
		})
		expect(
			await scope.sdk.plugin(parsePluginNodeAddress(Counter.nodeAddress())).config.get(),
		).toMatchObject({
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
		const { instance } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
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
		await expect(
			scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get(),
		).rejects.toMatchObject({
			details: { code: 'borrowed_generation_conflict' },
		})
		resolve(9)
		expect(await native).toBe(9)
		const foreign = runInNewContext('Promise.resolve(13)') as Promise<number>
		expect(instance.returnValue(foreign)).toBe(foreign)
		expect(await foreign).toBe(13)
		expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()).toMatchObject({
			config: { count: 2 },
		})
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('reports unsupported native Promise species without silently accepting or leaking an admission', async () => {
	const { host, scope } = await setup()
	let settle!: () => void
	try {
		const { instance } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
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
		expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()).toMatchObject({
			config: { count: 2 },
		})
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
		const { instance } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
		const management = scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()
		const business = instance.after(gate.promise)
		const combined = Promise.all([management, business])
		await expect(management).rejects.toMatchObject({
			details: { code: 'borrowed_generation_conflict' },
		})
		gate.resolve()
		await expect(combined).rejects.toMatchObject({
			details: { code: 'borrowed_generation_conflict' },
		})
		expect(await business).toBe(2)
		expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()).toMatchObject({
			config: { count: 2 },
		})
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
		const { instance } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
		const gate = Promise.withResolvers<void>()
		const pending = instance.after(gate.promise)
		await expect(
			scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get(),
		).rejects.toMatchObject({
			details: { code: 'borrowed_generation_conflict' },
		})
		await expect(scope.sdk.plugin(CounterDescriptor.nodeAddress()).restart()).rejects.toMatchObject(
			{
				details: { code: 'borrowed_generation_conflict' },
			},
		)
		const otherScope = createScriptScope({ ctx: host.ctx })
		let restarted = false
		const restart = otherScope.sdk
			.plugin(CounterDescriptor.nodeAddress())
			.restart()
			.then((): void => {
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
		const { instance: next } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
		expect(next.add(1)).toBe(3)
		await otherScope.dispose()
	} finally {
		await scope.dispose()
		await host.close()
	}
})

it('preserves unknown backend exceptions instead of classifying a matching code as an expected SDK error', async () => {
	const { host, scope } = await setup()
	const failure = Object.assign(new Error('Unexpected backend defect'), {
		code: 'control_contract_mismatch',
	})
	const read = vi
		.spyOn(requirePluginHostCoordinator(host.ctx), 'readCommitted')
		.mockRejectedValueOnce(failure)
	try {
		await expect(scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()).rejects.toBe(failure)
	} finally {
		read.mockRestore()
		await scope.dispose()
		await host.close()
	}
})

it('rejects member admission behind an already queued Host read instead of deadlocking a waiting restart', async () => {
	const { host, scope } = await setup()
	const otherScope = createScriptScope({ ctx: host.ctx })
	const gate = Promise.withResolvers<void>()
	try {
		const { instance } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
		const barrier = requirePluginHostCoordinator(host.ctx).runExclusive(
			'reverse-cycle-barrier',
			() => gate.promise,
		)
		const restart = otherScope.sdk.plugin(CounterDescriptor.nodeAddress()).restart()
		await tick()
		const management = scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()
		await tick()
		expect(() => instance.after(management.then((): void => undefined))).toThrow(
			/Await pending Host operations/,
		)
		gate.resolve()
		await barrier
		await restart
		expect(await management).toMatchObject({ config: { count: 2 } })
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
		const { instance } = await scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()
		await expect(
			instance.callback(() => scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()),
		).rejects.toMatchObject({ details: { code: 'borrowed_generation_conflict' } })
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
