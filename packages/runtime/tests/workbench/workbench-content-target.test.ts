import { describe, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import type { ContextLogger } from '@pluxel/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type {
	WorkbenchContentActionPresentation,
	WorkbenchContentObserver,
} from '@pluxel/runtime/workbench/client'
import { WorkbenchContentTarget } from '../../src/services/workbench/WorkbenchContentTarget'
import type { WorkbenchContentContract } from '../../src/services/workbench/WorkbenchContentPresentation'

const dataField = Object.freeze({
	kind: 'object' as const,
	name: 'status',
	path: 'status',
	depth: 0,
	meta: Object.freeze({ label: 'Status' }),
	required: true,
	fields: Object.freeze([
		Object.freeze({
			kind: 'number' as const,
			name: 'count',
			path: 'status.count',
			depth: 1,
			meta: Object.freeze({ label: 'Count' }),
			required: true,
		}),
	]),
})

function actionPresentation(
	key: string,
	input: 'none' | 'dialog' | 'embedded' = 'none',
): WorkbenchContentActionPresentation {
	return input === 'none'
		? Object.freeze({ kind: 'action', key, label: key, input: 'none' })
		: Object.freeze({ kind: 'action', key, label: key, input, fields: Object.freeze([]) })
}

function contract(input: {
	data?: boolean
	actions?: readonly Readonly<{
		key: string
		schema?: WorkbenchContentContract['actions'] extends ReadonlyMap<string, infer Action>
			? Action extends { schema?: infer Schema }
				? Schema
				: never
			: never
	}>[]
}): WorkbenchContentContract {
	const data = new Map()
	const slots: any[] = []
	if (input.data) {
		data.set('status', v.object({ count: v.number() }))
		slots.push({ kind: 'data', key: 'status', display: 'block', field: dataField })
	}
	const actions = new Map()
	for (const action of input.actions ?? []) {
		const presentation = actionPresentation(action.key, action.schema ? 'dialog' : 'none')
		actions.set(action.key, {
			...(action.schema ? { schema: action.schema } : {}),
			presentation,
		})
		slots.push(presentation)
	}
	return Object.freeze({
		presentation: Object.freeze({ slots: Object.freeze(slots) }),
		data,
		actions,
	}) as WorkbenchContentContract
}

function logger() {
	return { error: vi.fn() } as unknown as ContextLogger
}

function rpcObserver(handler: (outcome: unknown) => void | Promise<void>) {
	const disposeObserver = vi.fn()
	const disposeResults: ReturnType<typeof vi.fn>[] = []
	const callback = vi.fn((outcome: unknown) => {
		const disposeResult = vi.fn()
		disposeResults.push(disposeResult)
		return Object.assign(
			Promise.resolve().then(() => handler(outcome)),
			{
				[Symbol.dispose]: disposeResult,
			},
		)
	}) as unknown as RpcStub<WorkbenchContentObserver>
	Object.assign(callback, {
		dup: () => callback,
		[Symbol.dispose]: disposeObserver,
	})
	return { callback, disposeObserver, disposeResults }
}

describe('WorkbenchContentTarget', () => {
	it('retains the observer before initial load and pushes coalesced latest data', async () => {
		let state = 1
		const load = vi.fn(() => ({ status: { count: state } }))
		const root = new WorkbenchContentTarget(contract({ data: true }), logger())
		root.attach({ load })
		const updates: unknown[] = []
		const observer = rpcObserver((outcome) => updates.push(outcome))

		root.dataChanged()
		const initial = await root.subscribe(observer.callback)
		expect(initial).toMatchObject({ sequence: 1, ok: true, data: { status: { count: 1 } } })
		expect(updates).toEqual([])

		state = 2
		root.dataChanged()
		root.dataChanged()
		await vi.waitFor(() => expect(updates).toHaveLength(1))
		expect(updates[0]).toMatchObject({ sequence: 2, ok: true, data: { status: { count: 2 } } })
		expect(load).toHaveBeenCalledTimes(2)
		expect(observer.disposeResults.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)

		root[Symbol.dispose]()
		expect(observer.disposeObserver).toHaveBeenCalledTimes(1)
	})

	it('gives one waiting browser request priority over dirty refresh and bounds overlap', async () => {
		const order: string[] = []
		const gate = Promise.withResolvers<void>()
		let call = 0
		const root = new WorkbenchContentTarget(contract({ data: true }), logger())
		root.attach({
			load: async () => {
				call += 1
				if (call === 1) return { status: { count: 1 } }
				if (call === 2) {
					order.push('background')
					await gate.promise
					return { status: { count: 2 } }
				}
				order.push('browser')
				return { status: { count: 3 } }
			},
		})
		const observer = rpcObserver(() => undefined)
		await root.subscribe(observer.callback)

		root.dataChanged()
		await Promise.resolve()
		const waiting = root.load()
		await expect(root.load()).resolves.toEqual({ ok: false, code: 'busy' })
		root.dataChanged()
		root.dataChanged()
		gate.resolve()

		await expect(waiting).resolves.toMatchObject({ sequence: 3, ok: true })
		expect(order).toEqual(['background', 'browser'])
		expect(observer.callback).toHaveBeenCalledTimes(1)
		root[Symbol.dispose]()
	})

	it('validates action input, invokes typed handlers, and always post-loads started actions', async () => {
		const probeSchema = v.object({
			value: v.pipe(
				v.string(),
				v.transform((value) => Number(value)),
			),
		})
		const handler = vi.fn(({ value }: { value: number }) => {
			state = value
			return { ok: true as const, message: 'updated' }
		})
		let state = 0
		const load = vi.fn(() => ({ status: { count: state } }))
		const root = new WorkbenchContentTarget(
			contract({ data: true, actions: [{ key: 'probe', schema: probeSchema }] }),
			logger(),
		)
		root.attach({ load, actions: new Map([['probe', handler]]) })
		await root.subscribe(rpcObserver(() => undefined).callback)

		const invalid = await root.run('probe', { value: 1 })
		expect(invalid.action).toMatchObject({ ok: false, code: 'validation_failed' })
		expect(invalid.data).toBeNull()
		expect(handler).not.toHaveBeenCalled()

		const result = await root.run('probe', { value: '7' })
		expect(handler).toHaveBeenCalledWith({ value: 7 })
		expect(result).toMatchObject({
			action: { ok: true, message: 'updated' },
			data: { ok: true, data: { status: { count: 7 } } },
		})
		expect(load).toHaveBeenCalledTimes(2)
		root[Symbol.dispose]()
	})

	it('post-loads after an action throws and returns the latest data separately', async () => {
		let state = 1
		const load = vi.fn(() => ({ status: { count: state } }))
		const handler = vi.fn(() => {
			state = 2
			throw new Error('side effect failed after mutation')
		})
		const log = logger()
		const root = new WorkbenchContentTarget(
			contract({ actions: [{ key: 'mutate' }], data: true }),
			log,
		)
		root.attach({ load, actions: new Map([['mutate', handler]]) })
		await root.subscribe(rpcObserver(() => undefined).callback)

		await expect(root.run('mutate')).resolves.toMatchObject({
			action: { ok: false, code: 'action_failed' },
			data: { ok: true, data: { status: { count: 2 } } },
		})
		expect(handler).toHaveBeenCalledTimes(1)
		expect(load).toHaveBeenCalledTimes(2)
		expect(log.error).toHaveBeenCalledWith(
			'Workbench Content action failed',
			expect.objectContaining({ action: 'mutate' }),
		)
		root[Symbol.dispose]()
	})

	it('holds callback backpressure and coalesces one later latest-state push', async () => {
		let state = 1
		const callbackGate = Promise.withResolvers<void>()
		const load = vi.fn(() => ({ status: { count: state } }))
		const observer = rpcObserver(async () => {
			await callbackGate.promise
		})
		const root = new WorkbenchContentTarget(contract({ data: true }), logger())
		root.attach({ load })
		await root.subscribe(observer.callback)

		state = 2
		root.dataChanged()
		await vi.waitFor(() => expect(observer.callback).toHaveBeenCalledTimes(1))
		expect(load).toHaveBeenCalledTimes(2)

		state = 3
		root.dataChanged()
		root.dataChanged()
		await Promise.resolve()
		expect(load).toHaveBeenCalledTimes(2)
		expect(observer.callback).toHaveBeenCalledTimes(1)

		callbackGate.resolve()
		await vi.waitFor(() => expect(observer.callback).toHaveBeenCalledTimes(2))
		expect(load).toHaveBeenCalledTimes(3)
		expect(observer.disposeResults.every((dispose) => dispose.mock.calls.length === 1)).toBe(true)
		root[Symbol.dispose]()
	})

	it('resolves a browser load pending behind background work when closed', async () => {
		const backgroundGate = Promise.withResolvers<void>()
		const backgroundFinished = Promise.withResolvers<void>()
		let calls = 0
		const load = vi.fn(async () => {
			calls += 1
			if (calls === 2) {
				await backgroundGate.promise
				backgroundFinished.resolve()
			}
			return { status: { count: calls } }
		})
		const observer = rpcObserver(() => undefined)
		const root = new WorkbenchContentTarget(contract({ data: true }), logger())
		root.attach({ load })
		await root.subscribe(observer.callback)

		root.dataChanged()
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
		const pending = root.load()
		root[Symbol.dispose]()

		await expect(pending).resolves.toMatchObject({ ok: false, code: 'load_failed' })
		expect(observer.disposeObserver).toHaveBeenCalledTimes(1)
		backgroundGate.resolve()
		await backgroundFinished.promise
		await Promise.resolve()
		expect(observer.callback).not.toHaveBeenCalled()
	})

	it('resolves an initial load when closed and ignores its late author result', async () => {
		const loadStarted = Promise.withResolvers<void>()
		const loadGate = Promise.withResolvers<void>()
		const loadFinished = Promise.withResolvers<void>()
		const observer = rpcObserver(() => undefined)
		const root = new WorkbenchContentTarget(contract({ data: true }), logger())
		root.attach({
			load: async () => {
				loadStarted.resolve()
				await loadGate.promise
				loadFinished.resolve()
				return { status: { count: 1 } }
			},
		})

		const initial = root.subscribe(observer.callback)
		await loadStarted.promise
		root[Symbol.dispose]()

		const closed = await initial
		expect(closed).toEqual({ sequence: 2, ok: false, code: 'load_failed' })
		expect(observer.disposeObserver).toHaveBeenCalledTimes(1)

		loadGate.resolve()
		await loadFinished.promise
		await Promise.resolve()
		await expect(initial).resolves.toEqual(closed)
		expect(observer.callback).not.toHaveBeenCalled()
	})

	it('clears the observer deadline after a successful callback', async () => {
		vi.useFakeTimers()
		try {
			const root = new WorkbenchContentTarget(contract({ data: true }), logger())
			root.attach({ load: () => ({ status: { count: 1 } }) })
			const observer = rpcObserver(() => undefined)
			await root.subscribe(observer.callback)

			root.dataChanged()
			await vi.advanceTimersByTimeAsync(0)
			expect(observer.callback).toHaveBeenCalledTimes(1)
			expect(vi.getTimerCount()).toBe(0)
			root[Symbol.dispose]()
		} finally {
			vi.useRealTimers()
		}
	})

	it('closes only this root when its retained observer rejects', async () => {
		const log = logger()
		const root = new WorkbenchContentTarget(contract({ data: true }), log)
		root.attach({ load: () => ({ status: { count: 1 } }) })
		const observer = rpcObserver(() => Promise.reject(new Error('browser gone')))
		await root.subscribe(observer.callback)

		root.dataChanged()
		await vi.waitFor(() => expect(observer.disposeObserver).toHaveBeenCalledTimes(1))
		expect(observer.disposeResults).toHaveLength(1)
		expect(observer.disposeResults[0]).toHaveBeenCalledTimes(1)
		await expect(root.run('missing')).resolves.toMatchObject({
			action: { ok: false, code: 'invalid_input' },
		})
	})

	it('closes and releases a retained observer when its callback times out', async () => {
		vi.useFakeTimers()
		try {
			const root = new WorkbenchContentTarget(contract({ data: true }), logger())
			root.attach({ load: () => ({ status: { count: 1 } }) })
			const observer = rpcObserver(() => new Promise<void>(() => {}))
			await root.subscribe(observer.callback)

			root.dataChanged()
			await vi.advanceTimersByTimeAsync(0)
			expect(observer.callback).toHaveBeenCalledTimes(1)
			await vi.advanceTimersByTimeAsync(10_000)
			expect(observer.disposeObserver).toHaveBeenCalledTimes(1)
			expect(observer.disposeResults[0]).toHaveBeenCalledTimes(1)
			await expect(root.load()).resolves.toMatchObject({ ok: false, code: 'load_failed' })
		} finally {
			vi.useRealTimers()
		}
	})
})
