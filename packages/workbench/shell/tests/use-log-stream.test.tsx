// @vitest-environment jsdom
import type { PluginNodeAddress } from '@pluxel/core'
import type {
	LogRangeOk,
	LogStreamMeta,
	RuntimeLogEvent,
	RuntimeLogLine,
	RuntimeManagementClient,
} from '@pluxel/services/management/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeManagementClientProvider } from '../src/runtime'
import { useLogStream, type LogStreamState } from '../src/app/log_viewer/useLogStream'

const owner: PluginNodeAddress = {
	definition: { entry: { kind: 'package-root', packageName: '@test/logs' }, exportName: 'Logs' },
	variant: 'fork',
	forkId: 'east',
}
const meta: LogStreamMeta = {
	streamId: 'default',
	bootId: 'test',
	epoch: 1,
	headSeq: '1',
	tailSeq: '9000',
	nextSeq: '9001',
	count: 9000,
	retention: { windowLines: 10000 },
}
function line(seq: number, epoch = 1): RuntimeLogLine {
	return {
		streamId: 'default',
		epoch,
		seq: String(seq),
		ts: 1,
		level: 'info',
		category: ['test'],
		msg: `event-${epoch}-${seq}`,
		plugin: owner,
	}
}
function page(lines: RuntimeLogLine[], nextSeq = '9001', epoch = 1): LogRangeOk {
	return { ok: true, streamId: 'default', epoch, fromSeq: '1', nextSeq, lines }
}
function append(lines: RuntimeLogLine[]): RuntimeLogEvent {
	return {
		type: 'append',
		streamId: 'default',
		epoch: lines[0]?.epoch ?? 1,
		fromSeq: lines[0]?.seq ?? '1',
		nextSeq: String(Number(lines.at(-1)?.seq ?? 0) + 1),
		lines,
	}
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const roots: Root[] = []
const frames = new Map<number, FrameRequestCallback>()
let frameId = 0
beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		frames.set(++frameId, cb)
		return frameId
	})
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	frames.clear()
	document.body.replaceChildren()
	vi.unstubAllGlobals()
})
async function flush() {
	await act(async () => {
		const tasks = [...frames.values()]
		frames.clear()
		for (const task of tasks) task(0)
	})
}
function backend() {
	const observers: Array<(event: RuntimeLogEvent) => void> = []
	const releases: Array<ReturnType<typeof vi.fn>> = []
	const logs = {
		follow: vi.fn(async (_input: unknown, observe: (event: RuntimeLogEvent) => void) => {
			observers.push(observe)
			const release = vi.fn()
			releases.push(release)
			return { [Symbol.dispose]: release }
		}),
		meta: vi.fn(async (): Promise<LogStreamMeta> => meta),
		range: vi.fn(async (): Promise<LogRangeOk> => page([])),
	}
	return { logs, observers, releases, client: { logs } as unknown as RuntimeManagementClient }
}
async function mount(
	client: RuntimeManagementClient,
	options: { capacity?: number; historyLimit?: number } = {},
) {
	let state!: LogStreamState
	function Probe() {
		state = useLogStream({
			streamId: 'default',
			filter: { plugin: owner },
			capacity: options.capacity ?? 10,
			historyLimit: options.historyLimit ?? 10,
		})
		return null
	}
	const root = createRoot(document.body.appendChild(document.createElement('div')))
	roots.push(root)
	await act(async () =>
		root.render(
			<RuntimeManagementClientProvider client={client}>
				<Probe />
			</RuntimeManagementClientProvider>,
		),
	)
	return { root, state: () => state }
}

describe('independent log stream reader', () => {
	it('subscribes before reading and finds bounded matching history across empty pages far behind the global tail', async () => {
		const api = backend()
		api.logs.range
			.mockResolvedValueOnce(
				page(
					Array.from({ length: 8 }, (_, i) => line(i + 1)),
					'2000',
				),
			)
			.mockResolvedValueOnce(page([], '4000'))
			.mockResolvedValueOnce(page(Array.from({ length: 8 }, (_, i) => line(4000 + i))))
		const view = await mount(api.client, { capacity: 20, historyLimit: 10 })
		await flush()
		expect(api.logs.follow.mock.invocationCallOrder[0]).toBeLessThan(
			api.logs.meta.mock.invocationCallOrder[0]!,
		)
		expect(api.logs.range).toHaveBeenNthCalledWith(
			1,
			'default',
			expect.objectContaining({ fromSeq: '1', filter: { plugin: owner } }),
		)
		expect(api.logs.range).toHaveBeenNthCalledWith(
			2,
			'default',
			expect.objectContaining({ fromSeq: '2000', filter: { plugin: owner } }),
		)
		expect(
			view
				.state()
				.store.toArray()
				.map((row) => row.seq),
		).toEqual(['7', '8', ...Array.from({ length: 8 }, (_, i) => String(4000 + i))])
		expect(view.state().status).toBe('live')
	})
	it('merges late gap history in order, deduplicates and bounds RAF pending rows', async () => {
		const api = backend()
		api.logs.range.mockResolvedValueOnce(page([line(1), line(3)]))
		const view = await mount(api.client, { capacity: 4, historyLimit: 4 })
		await flush()
		const gap = deferred<LogRangeOk>()
		api.logs.range.mockReturnValueOnce(gap.promise)
		await act(async () => {
			api.observers[0]!({
				type: 'gap',
				streamId: 'default',
				epoch: 1,
				missingFrom: '2',
				missingTo: '2',
			})
			api.observers[0]!(append([line(4), line(5), line(5)]))
		})
		await act(async () => gap.resolve(page([line(2)], '3')))
		await flush()
		expect(
			view
				.state()
				.store.toArray()
				.map((row) => row.seq),
		).toEqual(['2', '3', '4', '5'])
		await act(async () => {
			for (let seq = 6; seq <= 100; seq++) api.observers[0]!(append([line(seq)]))
		})
		expect(frames.size).toBe(1)
		await flush()
		expect(
			view
				.state()
				.store.toArray()
				.map((row) => row.seq),
		).toEqual(['97', '98', '99', '100'])
	})
	it.each(['resolve', 'reject'] as const)(
		'ignores old epoch history that %ss after reset',
		async (outcome) => {
			const api = backend()
			const old = deferred<LogRangeOk>()
			api.logs.range.mockReturnValueOnce(old.promise)
			const view = await mount(api.client)
			await act(async () => {
				api.observers[0]!({
					...meta,
					type: 'reset',
					epoch: 2,
					headSeq: '1',
					tailSeq: '0',
					nextSeq: '1',
					count: 0,
				})
				api.observers[0]!(append([line(1, 2)]))
			})
			await act(async () => {
				if (outcome === 'resolve') old.resolve(page([line(9000)]))
				else old.reject(new Error('old epoch closed'))
			})
			await flush()
			expect(
				view
					.state()
					.store.toArray()
					.map((row) => [row.epoch, row.seq]),
			).toEqual([[2, '1']])
			expect(view.state().meta?.epoch).toBe(2)
			expect(view.state().status).toBe('live')
		},
	)
	it.each(['resolve', 'reject'] as const)(
		'isolates old boot reads that %s when a new boot reuses the epoch',
		async (outcome) => {
			const api = backend()
			const old = deferred<LogRangeOk>()
			api.logs.range.mockReturnValueOnce(old.promise)
			const view = await mount(api.client)
			await act(async () => {
				api.observers[0]!({
					...meta,
					type: 'reset',
					bootId: 'new-boot',
					headSeq: '1',
					tailSeq: '0',
					nextSeq: '1',
					count: 0,
				})
				api.observers[0]!(append([line(1)]))
			})
			await act(async () => {
				if (outcome === 'resolve') old.resolve(page([line(9000)]))
				else old.reject(new Error('old boot disconnected'))
			})
			await flush()
			expect(
				view
					.state()
					.store.toArray()
					.map((row) => row.seq),
			).toEqual(['1'])
			expect(view.state().meta?.bootId).toBe('new-boot')
			expect(view.state().status).toBe('live')
		},
	)

	it('clear does not restore an in-flight historical read, and retry creates a new subscription', async () => {
		const api = backend()
		const history = deferred<LogRangeOk>()
		api.logs.range.mockReturnValueOnce(history.promise)
		const view = await mount(api.client)
		await act(async () => view.state().clear())
		await act(async () => history.resolve(page([line(1), line(2)])))
		await flush()
		expect(view.state().store.length).toBe(0)
		await act(async () => api.observers[0]!(append([line(9001)])))
		await flush()
		expect(view.state().store.get(0)?.seq).toBe('9001')
		await act(async () => view.state().retry())
		expect(api.releases[0]).toHaveBeenCalledOnce()
		expect(api.logs.follow).toHaveBeenCalledTimes(2)
		await act(async () => api.observers[0]!(append([line(9002)])))
		await flush()
		expect(view.state().store.length).toBe(0)
	})
	it('disposes a subscription resolving after unmount and never starts a historical read', async () => {
		const api = backend()
		const follow = deferred<Disposable>()
		const release = vi.fn()
		api.logs.follow.mockReturnValueOnce(follow.promise)
		const view = await mount(api.client)
		await act(async () => view.root.unmount())
		roots.pop()
		await act(async () => follow.resolve({ [Symbol.dispose]: release }))
		expect(release).toHaveBeenCalledOnce()
		expect(api.logs.meta).not.toHaveBeenCalled()
		expect(api.logs.range).not.toHaveBeenCalled()
	})
	it('ignores an old request rejection after retry has created a new reader generation', async () => {
		const api = backend()
		const old = deferred<LogRangeOk>()
		api.logs.range.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([line(9000)]))
		const view = await mount(api.client)
		await act(async () => view.state().retry())
		await flush()
		await act(async () => old.reject(new Error('old request rejected')))
		expect(view.state().status).toBe('live')
		expect(view.state().error).toBeNull()
		expect(view.state().store.get(0)?.seq).toBe('9000')
	})

	it('recovers a bootstrap buffer overflow with a fresh bounded snapshot', async () => {
		const api = backend()
		const first = deferred<LogRangeOk>()
		api.logs.range
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(page(Array.from({ length: 20 }, (_, i) => line(8981 + i))))
		const view = await mount(api.client)
		await act(async () =>
			api.observers[0]!(append(Array.from({ length: 3000 }, (_, i) => line(6001 + i)))),
		)
		await act(async () => first.resolve(page([line(1)])))
		await flush()
		expect(api.logs.meta).toHaveBeenCalledTimes(2)
		expect(view.state().status).toBe('live')
		expect(
			view
				.state()
				.store.toArray()
				.map((row) => row.seq),
		).toEqual(Array.from({ length: 10 }, (_, i) => String(8991 + i)))
	})

	it('isolates independent readers and surfaces failure until an explicit retry', async () => {
		const api = backend()
		api.logs.range.mockRejectedValueOnce(new Error('read failed'))
		const first = await mount(api.client)
		const second = await mount(api.client)
		expect(first.state().status).toBe('error')
		expect(first.state().error).toBe('read failed')
		expect(api.releases[0]).toHaveBeenCalledOnce()
		await act(async () => api.observers[1]!(append([line(9001)])))
		await flush()
		expect(second.state().store.length).toBe(1)
		expect(first.state().store.length).toBe(0)
		await act(async () => first.state().retry())
		expect(first.state().status).toBe('live')
		expect(api.logs.follow).toHaveBeenCalledTimes(3)
	})
})
