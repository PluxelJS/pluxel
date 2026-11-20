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
import { installAnimationFrames } from './animation-frames'
import { RuntimeManagementClientProvider } from '../../src/runtime'
import { LogPreview } from '../../src/app/log_viewer/LogPreview'
import { prepareNativeWorkbenchDom } from '../fixtures/native-workbench'

vi.mock('../../src/theme', () => ({
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
let frames: ReturnType<typeof installAnimationFrames>
beforeEach(() => {
	prepareNativeWorkbenchDom()
	frames = installAnimationFrames()
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
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
		await frames.flush()
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
		await frames.flush()
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
		expect(frames.pending).toBe(0)
	})
})
