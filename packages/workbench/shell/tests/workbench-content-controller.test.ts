import type {
	WorkbenchContentDataOutcome,
	WorkbenchOpenedContentHandle,
} from '@pluxel/workbench/client'
import { describe, expect, it, vi } from 'vitest'
import { WorkbenchContentController } from '../src/app/workbench/WorkbenchContentController'

describe('WorkbenchContentController', () => {
	it('keeps the newest subscription outcome when the callback beats the initial result', async () => {
		const initial = deferred<WorkbenchContentDataOutcome>()
		const handle = interactiveHandle({
			subscribe: vi.fn(async (observer) => {
				await observer({ sequence: 2, ok: true as const, data: { status: 'live' } })
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

		initial.resolve({ sequence: 1, ok: true as const, data: { status: 'old' } })
		await tick()
		expect(controller.getSnapshot().data).toEqual({ status: 'live' })
	})

	it('retries without replacing data for busy or older load results', async () => {
		const handle = interactiveHandle({
			subscribe: vi.fn(async () => ({ sequence: 3, ok: true as const, data: { count: 3 } })),
			load: vi
				.fn()
				.mockResolvedValueOnce({ ok: false, code: 'busy' })
				.mockResolvedValueOnce({ sequence: 2, ok: true as const, data: { count: 2 } }),
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
				action: { ok: true as const, message: 'done' },
				data: { sequence: 4, ok: true as const, data: { status: 'done' } },
			})),
		})
		const controller = new WorkbenchContentController(handle)
		const listener = vi.fn()
		controller.subscribe(listener)
		controller.start()

		expect(await controller.run('save')).toEqual({ ok: true as const, message: 'done' })
		expect(controller.getSnapshot().data).toEqual({ status: 'done' })
		const callsBeforeDispose = listener.mock.calls.length

		const retry = controller.retry()
		controller[Symbol.dispose]()
		subscription.resolve({ sequence: 5, ok: true as const, data: { status: 'late-subscribe' } })
		load.resolve({ sequence: 6, ok: true as const, data: { status: 'late-load' } })
		await retry
		await tick()

		expect(controller.getSnapshot().data).toEqual({ status: 'done' })
		expect(listener).toHaveBeenCalledTimes(callsBeforeDispose + 1)
	})

	it('runs an action-only publication without retaining data resources', async () => {
		const subscribe = vi.fn()
		const run = vi.fn(async () => ({ action: { ok: true as const }, data: null }))
		using controller = new WorkbenchContentController(
			interactiveHandle({
				presentation: {
					slots: [{ kind: 'action', key: 'refresh', label: 'Refresh', input: 'none' }],
				},
				subscribe,
				run,
			}),
		)
		controller.start()

		expect(await controller.run('refresh')).toEqual({ ok: true })
		expect(run).toHaveBeenCalledExactlyOnceWith('refresh')
		expect(subscribe).not.toHaveBeenCalled()
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
		subscribe: vi.fn(async () => ({ sequence: 1, ok: true as const, data: {} })),
		load: vi.fn(async () => ({ sequence: 1, ok: true as const, data: {} })),
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
