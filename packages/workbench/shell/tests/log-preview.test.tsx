// @vitest-environment jsdom
import type { PluginNodeAddress } from '@pluxel/core'
import { MantineProvider } from '@mantine/core'
import type {
	RuntimeManagementClient,
	RuntimeLogEvent,
	RuntimeLogLine,
} from '@pluxel/services/management/client'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeManagementClientProvider } from '../src/runtime'
import { LogPreview } from '../src/app/log_viewer/LogPreview'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

vi.mock('../src/theme', () => ({
	useThemeModel: () => ({
		log: {
			listStripe: 'transparent',
			levels: { info: 'blue', default: 'gray' },
			ansi16: [],
		},
	}),
}))
const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/bots' },
		exportName: 'BotPlugin',
	},
	variant: 'fork',
	forkId: 'east',
}
const meta = {
	streamId: 'default',
	bootId: 'test',
	epoch: 1,
	headSeq: '100',
	tailSeq: '9000',
	nextSeq: '9001',
	count: 8901,
	retention: { windowLines: 10000 },
}
const roots: Root[] = []
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
beforeEach(() => {
	prepareNativeWorkbenchDom()
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		const id = ++nextFrame
		frames.set(id, callback)
		return id
	})
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	frames.clear()
	document.body.replaceChildren()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
function line(seq: number): RuntimeLogLine {
	return {
		streamId: 'default',
		epoch: 1,
		seq: String(seq),
		ts: 1,
		level: 'info',
		category: ['test'],
		msg: `event-${seq}`,
		plugin: owner,
	}
}
async function flushFrames() {
	await act(async () => {
		const pending = [...frames.values()]
		frames.clear()
		for (const frame of pending) frame(0)
	})
}
async function mount(client: RuntimeManagementClient) {
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<RuntimeManagementClientProvider client={client}>
					<LogPreview owner={owner} />
				</RuntimeManagementClientProvider>
			</MantineProvider>,
		)
	})
	return { root, container }
}
function rows(container: HTMLElement) {
	return [...container.querySelectorAll('li')].map(
		(row) => row.textContent?.match(/event-\d+/)?.[0],
	)
}

describe('plugin log preview', () => {
	it('scans the retained window with exact fork filtering, including empty pages, and keeps only ten latest plugin lines', async () => {
		let observe!: (event: RuntimeLogEvent) => void
		const dispose = vi.fn()
		const range = vi.fn(async (_stream: string, input: { fromSeq: string; filter: unknown }) => {
			expect(input.filter).toMatchObject({ plugin: owner })
			const pages: Record<string, { nextSeq: string; lines: RuntimeLogLine[] }> = {
				'100': { nextSeq: '2000', lines: Array.from({ length: 6 }, (_, i) => line(100 + i)) },
				'2000': { nextSeq: '4000', lines: [] },
				'4000': { nextSeq: '6000', lines: Array.from({ length: 6 }, (_, i) => line(4000 + i)) },
				'6000': { nextSeq: '9001', lines: [] },
			}
			const page = pages[input.fromSeq]
			if (!page) throw new Error(`Unexpected cursor ${input.fromSeq}`)
			return { ok: true, streamId: 'default', epoch: 1, fromSeq: input.fromSeq, ...page }
		})
		const follow = vi.fn(async (_input: unknown, observer: typeof observe) => {
			observe = observer
			return { [Symbol.dispose]: dispose }
		})
		const client = {
			logs: { follow, meta: vi.fn(async () => meta), range },
		} as unknown as RuntimeManagementClient
		const { container, root } = await mount(client)
		await flushFrames()
		expect(follow).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				streamId: 'default',
				filter: expect.objectContaining({ plugin: owner }),
			}),
			expect.any(Function),
		)
		expect(range.mock.calls.map(([, input]) => input.fromSeq)).toEqual([
			'100',
			'2000',
			'4000',
			'6000',
		])
		expect(rows(container)).toEqual(
			[102, 103, 104, 105, 4000, 4001, 4002, 4003, 4004, 4005].map((seq) => `event-${seq}`),
		)
		await act(async () =>
			observe({
				type: 'append',
				streamId: 'default',
				epoch: 1,
				fromSeq: '9001',
				nextSeq: '9021',
				lines: Array.from({ length: 20 }, (_, i) => line(9001 + i)),
			}),
		)
		await flushFrames()
		expect(rows(container)).toEqual(Array.from({ length: 10 }, (_, i) => `event-${9011 + i}`))
		await act(async () => root.unmount())
		roots.pop()
		expect(dispose).toHaveBeenCalledOnce()
		await act(async () =>
			observe({
				type: 'append',
				streamId: 'default',
				epoch: 1,
				fromSeq: '9021',
				nextSeq: '9022',
				lines: [line(9021)],
			}),
		)
		expect(frames.size).toBe(0)
	})

	it('does not replay old bootstrap notifications over the latest ten rows', async () => {
		const current = { ...meta, headSeq: '1', tailSeq: '30', nextSeq: '31', count: 30 }
		const client = {
			logs: {
				follow: vi.fn(async (_input: unknown, observe: (event: RuntimeLogEvent) => void) => {
					observe({
						type: 'append',
						streamId: 'default',
						epoch: 1,
						fromSeq: '1',
						nextSeq: '2',
						lines: [line(1)],
					})
					return { [Symbol.dispose]: vi.fn() }
				}),
				meta: vi.fn(async () => current),
				range: vi.fn(async () => ({
					ok: true,
					streamId: 'default',
					epoch: 1,
					fromSeq: '1',
					nextSeq: '31',
					lines: Array.from({ length: 30 }, (_, i) => line(i + 1)),
				})),
			},
		} as unknown as RuntimeManagementClient
		const { container } = await mount(client)
		await flushFrames()
		expect(rows(container)).toEqual(Array.from({ length: 10 }, (_, i) => `event-${21 + i}`))
	})

	it('disposes a subscription that arrives after unmount without reading history', async () => {
		let resolve!: (subscription: Disposable) => void
		const dispose = vi.fn()
		const readMeta = vi.fn(async () => meta)
		const range = vi.fn()
		const client = {
			logs: {
				follow: vi.fn(
					() =>
						new Promise<Disposable>((done) => {
							resolve = done
						}),
				),
				meta: readMeta,
				range,
			},
		} as unknown as RuntimeManagementClient
		const { root } = await mount(client)
		await act(async () => root.unmount())
		roots.pop()
		await act(async () => resolve({ [Symbol.dispose]: dispose }))
		expect(dispose).toHaveBeenCalledOnce()
		expect(readMeta).not.toHaveBeenCalled()
		expect(range).not.toHaveBeenCalled()
		expect(frames.size).toBe(0)
	})
})
