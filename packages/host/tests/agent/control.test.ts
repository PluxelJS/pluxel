import { BasePlugin, Plugin, parsePluginNodeAddress, type PluginNodeAddress } from '@pluxel/core'
import { CorePluginGraphVerificationError, requirePluginService } from '@pluxel/core/internal'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { createHost, HostStatePersistenceError, PluginGraphRejectedError } from '../../src'
import { requirePluginHostCoordinator, setHostCatalogProvenance } from '../../src/internal'
import type { PluginDescriptor } from '../../src/agent'
import { createScriptScope, ScriptError } from '../../src/agent-runtime'
import { createPluginControlReference } from '../../src/control-reference'
import { PluginControlError } from '../../src/catalog'

const configHash = `sha256:${'a'.repeat(64)}`
const instanceHash = `sha256:${'b'.repeat(64)}`
const wrongHash = `sha256:${'c'.repeat(64)}`
const contracts = { config: configHash, instance: instanceHash }
const availableControl = { state: 'available', format: 2, contracts } as const
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
type CounterControl = PluginDescriptor<{ count?: number }, { count: number }, Counter>

function counterControl(overrides: Partial<typeof contracts> = {}): CounterControl {
	return createPluginControlReference({
		format: 2,
		definition: Counter.address(),
		contracts: { ...contracts, ...overrides },
	}) as unknown as CounterControl
}

const CounterDescriptor = counterControl()

async function setup() {
	await using resources = new AsyncDisposableStack()
	const host = resources.use(
		await createHost({
			plugins: [{ plugin: Counter }],
			policy: { document: false },
			config: { document: false },
		}),
	)
	setHostCatalogProvenance(host.ctx, new Map([[Counter, { control: availableControl }]]))
	await host.start()
	const scope = resources.use(createScriptScope({ ctx: host.ctx }))
	await scope.sdk.plugin(Counter.nodeAddress()).start()
	const lifetime = resources.move()
	return { host, scope, [Symbol.asyncDispose]: () => lifetime.disposeAsync() }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

it('keeps JSON identities dynamic and refuses copied typed address evidence', async () => {
	await using fixture = await setup()
	const { scope } = fixture
	const address = CounterDescriptor.nodeAddress()
	expect(() => scope.sdk.plugin({ ...address })).toThrow('copied or detached')
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
})

it('borrows a plugin and captures script revisions without projecting the Core graph', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
	using projectGraph = vi.spyOn(requirePluginService(host.ctx), 'readCommittedDependencyAdjacency')
	const selected = scope.sdk.plugin(CounterDescriptor.nodeAddress())
	const before = await scope.snapshot()
	const { instance } = await selected.instance()
	const context = await selected.context()
	expect(instance.privateValue()).toBe(7)
	expect(context).toBe(instance.ctx)

	await scope.dispose()
	await expect(scope.snapshot()).resolves.toEqual(before)
	expect(projectGraph).not.toHaveBeenCalled()
})

it('captures immutable targets and applies extracted operations to one deployed fork', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
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
	expect(await validate({ set: { count: 5 } })).toMatchObject({
		config: { count: 5 },
		persistence: { status: 'unchanged' },
	})
	expect(await get()).toMatchObject({ config: { count: 2 } })
	expect(await patch({ set: { count: 8 } })).toMatchObject({
		config: { count: 8 },
	})
	expect(await get()).toMatchObject({ config: { count: 8 } })
	expect(await dynamic.config.get()).toMatchObject({ config: { count: 2 } })
	expect(await reset()).toMatchObject({ config: { count: 2 } })
	await stop()
	expect(await status()).toMatchObject({ lifecycleState: 'stopped' })
	expect(requirePluginService(host.ctx).isRunning(Counter.nodeAddress())).toBe(true)
})

it('refreshes a current generation through the same ref and closes cached selectors and methods with their scope', async () => {
	await using fixture = await setup()
	const { scope } = fixture
	const { plugin } = scope.sdk
	const ref = plugin(CounterDescriptor.nodeAddress())
	const { status, restart, instance, config } = ref
	const { get, patch } = config
	const { instance: first } = await instance()
	expect(first.add(10)).toBe(12)
	await restart()
	expect(() => first.add(1)).toThrow(/owner stopped/i)
	const { instance: current } = await instance()
	expect(Object.is(current, first)).toBe(false)
	expect(current.add(1)).toBe(3)
	await scope.dispose()
	expect(() => plugin(CounterDescriptor.nodeAddress())).toThrow(/closing or closed/)
	const calls: (() => Promise<unknown>)[] = [
		status,
		restart,
		instance,
		get,
		() => patch({ set: { count: 9 } }),
	]
	for (const call of calls)
		await expect(call()).rejects.toMatchObject({
			details: { code: 'scope_closed' },
		})
	expect(() => current.add(1)).toThrow(/closing or closed/)
})

it('drains an admitted expected failure without reporting a second cleanup rejection', async () => {
	await using fixture = await setup()
	const { scope } = fixture
	const accepted = scope.sdk.plugins.list()
	const disposal = scope.dispose()
	await expect(accepted).rejects.toMatchObject({
		details: { code: 'scope_closed' },
	})
	await expect(disposal).resolves.toBeUndefined()
})

it('classifies a pre-aborted mutation before its error details and leaves Host state unchanged', async () => {
	await using fixture = await setup()
	const { plugin, policy } = fixture.scope.sdk
	const { get, patch, reset } = plugin(CounterDescriptor.nodeAddress()).config
	const before = await get()
	const policyBefore = await policy.get()
	const signal = AbortSignal.abort(
		new ScriptError({
			code: 'persistence_failed',
			state: 'unknown',
			message: 'cancel this mutation',
		}),
	)
	for (const operation of [
		() => patch({ set: { count: 99 } }, { signal }),
		() => reset(undefined, { signal }),
		() => policy.patch({ startConcurrency: 2 }, { signal }),
		() => policy.reset(undefined, { signal }),
	])
		await expect(operation()).rejects.toMatchObject({ details: { code: 'cancelled' } })
	const after = await get()
	expect(after.config).toEqual(before.config)
	expect(after.managedRevision).toBe(before.managedRevision)
	expect(await policy.get()).toEqual(policyBefore)
})

it('classifies a queued cancellation by signal identity before a known control error and drains cleanly', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
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
	}
})

it.each(['validate', 'reset'] as const)(
	'cancels a queued policy %s with a persistence-shaped reason without changing managed policy',
	async (operation) => {
		await using fixture = await setup()
		const { host, scope } = fixture
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
		}
	},
)

it('retains a known Core graph rejection cause in the lifecycle error without replacing the generation', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
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
	}
})

it('checks config and instance contracts independently after address type erasure and reselection', async () => {
	await using fixture = await setup()
	const { plugin } = fixture.scope.sdk
	const sourceAddress: PluginNodeAddress = Counter.nodeAddress()
	const controlAddress: PluginNodeAddress = CounterDescriptor.nodeAddress()
	for (const address of [sourceAddress, controlAddress])
		expect(await plugin(address).config.get()).toMatchObject({ config: { count: 2 } })

	const wrongInstance = plugin(counterControl({ instance: wrongHash }).nodeAddress())
	expect(await wrongInstance.config.get()).toMatchObject({ config: { count: 2 } })
	await expect(wrongInstance.instance()).rejects.toMatchObject({
		details: { code: 'control_contract_mismatch' },
	})

	const wrongConfig = plugin(counterControl({ config: wrongHash }).nodeAddress())
	const erasedAddress: PluginNodeAddress = wrongConfig.address
	const reselected = plugin(plugin(erasedAddress).address)
	await expect(reselected.config.get()).rejects.toMatchObject({
		details: { code: 'control_contract_mismatch' },
	})
	await expect(wrongConfig.config.patch({ set: { count: 8 } })).rejects.toMatchObject({
		details: { code: 'control_contract_mismatch' },
	})
	expect(await wrongConfig.status()).toMatchObject({ lifecycleState: 'running' })
	const { instance } = await wrongConfig.instance()
	expect(instance.count).toBe(2)
	expect(await plugin(controlAddress).config.get()).toMatchObject({ config: { count: 2 } })
})

it('reports committed control preparation failures through ordinary SDK status issues without disabling the Plugin', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
	const selected = scope.sdk.plugin(CounterDescriptor.nodeAddress())
	for (const reason of ['analysis_failed', 'missing'] as const) {
		const message = `control ${reason}: fixture input cannot be represented`
		const previousStatus = await selected.status()
		setHostCatalogProvenance(
			host.ctx,
			new Map([[Counter, { control: { state: 'unavailable', reason, message } }]]),
		)
		expect(await selected.status()).toEqual(previousStatus)
		await host.updateCatalog([Counter])
		const status = await selected.status()
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
	setHostCatalogProvenance(host.ctx, new Map([[Counter, { control: availableControl }]]))
	await host.updateCatalog([Counter])
	expect(await selected.status()).toMatchObject({
		availability: 'available',
		lifecycleState: 'running',
		issues: [],
	})
	const { instance: borrowed } = await selected.instance()
	expect(borrowed.count).toBe(2)
})

it('admits actual instance members, preserves JavaScript receivers and never probes business then', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
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
})

it('checks typed configuration against the catalog actually admitted on the original transaction queue', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
	const gate = Promise.withResolvers<void>()
	const barrier = requirePluginHostCoordinator(host.ctx).runExclusive(
		'control-test-barrier',
		() => gate.promise,
	)
	const control = { ...availableControl, contracts: { ...contracts, config: wrongHash } }
	try {
		setHostCatalogProvenance(host.ctx, new Map([[Counter, { control }]]))
		const replacement = host.updateCatalog([Counter])
		await tick()
		const mutation = scope.sdk
			.plugin(CounterDescriptor.nodeAddress())
			.config.patch({ set: { count: 100 } })
		gate.resolve()
		await replacement
		await expect(mutation).rejects.toMatchObject({
			details: { code: 'control_contract_mismatch' },
		})
		expect(
			await scope.sdk.plugin(parsePluginNodeAddress(Counter.nodeAddress())).config.get(),
		).toMatchObject({ config: { count: 2 } })
	} finally {
		gate.resolve()
		await barrier
	}
})

it('preserves native Promise subclasses and leaves lazy business thenables untouched', async () => {
	await using fixture = await setup()
	const { scope } = fixture
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
	try {
		expect(instance.returnValue(native)).toBe(native)
		await expect(
			scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get(),
		).rejects.toMatchObject({ details: { code: 'borrowed_generation_conflict' } })
	} finally {
		resolve(9)
	}
	expect(await native).toBe(9)
	const foreign = runInNewContext('Promise.resolve(13)') as Promise<number>
	expect(instance.returnValue(foreign)).toBe(foreign)
	expect(await foreign).toBe(13)
	expect(await scope.sdk.plugin(CounterDescriptor.nodeAddress()).config.get()).toMatchObject({
		config: { count: 2 },
	})
})

it('reports unsupported native Promise species without silently accepting or leaking an admission', async () => {
	await using fixture = await setup()
	const { scope } = fixture
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
	}
})

it('rejects Promise.all queue/member cycles without leaving the provider admitted', async () => {
	await using fixture = await setup()
	const { scope } = fixture
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
	}
})

it('holds provider cleanup until a native Promise settles and rejects cyclic queued operations', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
	await using otherScope = createScriptScope({ ctx: host.ctx })
	cleanups = 0
	const selected = scope.sdk.plugin(CounterDescriptor.nodeAddress())
	const { instance } = await selected.instance()
	const gate = Promise.withResolvers<void>()
	const pending = instance.after(gate.promise)
	try {
		await expect(selected.restart()).rejects.toMatchObject({
			details: { code: 'borrowed_generation_conflict' },
		})
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
		const { instance: next } = await selected.instance()
		expect(next.add(1)).toBe(3)
	} finally {
		gate.resolve()
	}
})

it('preserves unknown backend exceptions instead of classifying a matching code as an expected SDK error', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
	const failure = Object.assign(new Error('Unexpected backend defect'), {
		code: 'control_contract_mismatch',
	})
	using _getInstance = vi
		.spyOn(requirePluginService(host.ctx), 'getInstance')
		.mockImplementationOnce(() => {
			throw failure
		})
	await expect(scope.sdk.plugin(CounterDescriptor.nodeAddress()).instance()).rejects.toBe(failure)
})

it('rejects member admission behind an already queued Host read instead of deadlocking a waiting restart', async () => {
	await using fixture = await setup()
	const { host, scope } = fixture
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
	}
})

it('rejects a member callback queued read and drains unawaited native Promise members on scope close', async () => {
	await using fixture = await setup()
	const { scope } = fixture
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
	try {
		await tick()
		expect(disposed).toBe(false)
	} finally {
		gate.resolve()
	}
	await result
	await disposal
	expect(disposed).toBe(true)
})
