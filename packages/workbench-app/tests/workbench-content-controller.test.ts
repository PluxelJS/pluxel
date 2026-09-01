import type {
	WorkbenchContentDataOutcome,
	WorkbenchOpenedContentHandle,
} from '@pluxel/runtime/workbench/client'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchContentController } from '../src/app/workbench/WorkbenchContentController'

describe('WorkbenchContentController', () => {
	it('keeps the newest subscription outcome when the callback beats the initial result', async () => {
		const initial = deferred<WorkbenchContentDataOutcome>()
		const handle = interactiveHandle({
			subscribe: vi.fn(async (observer) => {
				await observer({ sequence: 2, ok: true, data: { status: 'live' } })
				return initial.promise
			}),
		})
		const controller = new WorkbenchContentController(handle)

		controller.start()
		await tick()
		expect(controller.getSnapshot()).toMatchObject({
			status: 'ready',
			data: { status: 'live' },
			stale: false,
		})

		initial.resolve({ sequence: 1, ok: true, data: { status: 'old' } })
		await tick()
		expect(controller.getSnapshot().data).toEqual({ status: 'live' })
	})

	it('keeps the last good data stale after a newer failure and clears it on recovery', async () => {
		let observer!: (outcome: WorkbenchContentDataOutcome) => void | Promise<void>
		const handle = interactiveHandle({
			subscribe: vi.fn(async (next) => {
				observer = next
				return { sequence: 1, ok: true, data: { count: 1 } }
			}),
		})
		const controller = new WorkbenchContentController(handle)
		controller.start()
		await tick()

		observer({ sequence: 2, ok: false, code: 'load_failed' })
		expect(controller.getSnapshot()).toMatchObject({
			status: 'ready',
			data: { count: 1 },
			stale: true,
		})

		observer({ sequence: 3, ok: true, data: { count: 2 } })
		expect(controller.getSnapshot()).toMatchObject({
			status: 'ready',
			data: { count: 2 },
			stale: false,
		})
	})

	it('retries without replacing data for busy or older load results', async () => {
		const handle = interactiveHandle({
			subscribe: vi.fn(async () => ({ sequence: 3, ok: true, data: { count: 3 } })),
			load: vi
				.fn()
				.mockResolvedValueOnce({ ok: false, code: 'busy' })
				.mockResolvedValueOnce({ sequence: 2, ok: true, data: { count: 2 } }),
		})
		const controller = new WorkbenchContentController(handle)
		controller.start()
		await tick()

		await controller.retry()
		await controller.retry()

		expect(controller.getSnapshot()).toMatchObject({
			status: 'ready',
			data: { count: 3 },
			refreshing: false,
		})
	})

	it('applies action data and ignores all late outcomes after disposal', async () => {
		const subscription = deferred<WorkbenchContentDataOutcome>()
		const load = deferred<WorkbenchContentDataOutcome>()
		const handle = interactiveHandle({
			subscribe: vi.fn(async () => subscription.promise),
			load: vi.fn(async () => load.promise),
			run: vi.fn(async () => ({
				action: { ok: true, message: 'done' },
				data: { sequence: 4, ok: true, data: { status: 'done' } },
			})),
		})
		const controller = new WorkbenchContentController(handle)
		const listener = vi.fn()
		controller.subscribe(listener)
		controller.start()

		expect(await controller.run('save')).toEqual({ ok: true, message: 'done' })
		expect(controller.getSnapshot().data).toEqual({ status: 'done' })
		const callsBeforeDispose = listener.mock.calls.length

		const retry = controller.retry()
		controller[Symbol.dispose]()
		subscription.resolve({ sequence: 5, ok: true, data: { status: 'late-subscribe' } })
		load.resolve({ sequence: 6, ok: true, data: { status: 'late-load' } })
		await retry
		await tick()

		expect(controller.getSnapshot().data).toEqual({ status: 'done' })
		expect(listener).toHaveBeenCalledTimes(callsBeforeDispose + 1)
	})

	it('runs action-only Content without creating a data subscription', async () => {
		const subscribe = vi.fn()
		const run = vi.fn(async () => ({ action: { ok: true as const }, data: null }))
		const handle = interactiveHandle({
			presentation: {
				slots: [{ kind: 'action', key: 'refresh', label: 'Refresh', input: 'none' }],
			},
			subscribe,
			run,
		})
		const controller = new WorkbenchContentController(handle)

		controller.start()
		expect(await controller.run('refresh')).toEqual({ ok: true })

		expect(subscribe).not.toHaveBeenCalled()
		expect(run).toHaveBeenCalledWith('refresh')
	})
})

function interactiveHandle(
	overrides: Partial<
		Pick<WorkbenchOpenedContentHandle, 'presentation' | 'subscribe' | 'load' | 'run'>
	>,
): WorkbenchOpenedContentHandle {
	return {
		mode: 'interactive',
		presentation: {
			slots: [
				{
					kind: 'data',
					key: 'status',
					display: 'inline',
					field: {} as never,
				},
			],
		},
		subscribe: vi.fn(async () => ({ sequence: 1, ok: true, data: {} })),
		load: vi.fn(async () => ({ sequence: 1, ok: true, data: {} })),
		run: vi.fn(async () => ({ action: { ok: true }, data: null })),
		...overrides,
	} as unknown as WorkbenchOpenedContentHandle
}

function deferred<Value>() {
	let resolve!: (value: Value) => void
	const promise = new Promise<Value>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

async function tick() {
	await Promise.resolve()
	await Promise.resolve()
}
