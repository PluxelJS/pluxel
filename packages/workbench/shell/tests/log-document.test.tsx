// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogStreamMeta, RuntimeLogLine } from '../src/runtime'
import type { LogStreamState } from '../src/app/log_viewer/useLogStream'
import type { LogListProps } from '../src/app/log_viewer/LogList'
import { createLogStreamStore } from '../src/app/log_viewer/logStreamStore'
import { LogsPage } from '../src/app/log_viewer/LogsPage'
import { WorkbenchNavigationProvider } from '../src/app/workbench/context'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

vi.mock('../src/app/log_viewer/useLogStream', () => ({ useLogStream: () => stream }))
vi.mock('../src/app/log_viewer/LogFilters', () => ({ LogFilters: () => null }))
vi.mock('../src/app/log_viewer/LogPolicyPopover', () => ({ LogPolicyPopover: () => null }))
vi.mock('../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({ overview: undefined }),
}))
// Real row rendering/virtualization has its own suite; expose only selection and follow here.
vi.mock('../src/app/log_viewer/LogList', () => ({
	LogList: ({ store, onSelect, follow }: LogListProps) => (
		<div aria-label="日志列表" data-follow={String(follow)}>
			{store.toArray().map((line) => (
				<button key={`${line.epoch}:${line.seq}`} onClick={() => onSelect(line)}>
					{line.msg}
				</button>
			))}
		</div>
	),
}))
let root: Root | undefined
let host: HTMLDivElement
let store: ReturnType<typeof createLogStreamStore>
let stream: LogStreamState
const meta: LogStreamMeta = {
	streamId: 'default',
	bootId: 'first',
	epoch: 1,
	headSeq: '1',
	tailSeq: '1',
	nextSeq: '2',
	count: 1,
	retention: { windowLines: 100 },
}
function line(seq: number, epoch = 1, msg = `message-${seq}`): RuntimeLogLine {
	return {
		streamId: 'default',
		epoch,
		seq: String(seq),
		ts: 1000,
		level: 'info',
		msg,
		props: { request: 'retained-detail' },
	}
}
beforeEach(() => {
	prepareNativeWorkbenchDom()
	store = createLogStreamStore(100)
	store.append([line(1)])
	stream = {
		store,
		meta: { ...meta },
		status: 'live',
		error: null,
		clear: vi.fn(() => store.clear()),
		retry: vi.fn(),
	}
	host = document.body.appendChild(document.createElement('div'))
})
afterEach(async () => {
	if (root) await act(async () => root!.unmount())
	root = undefined
	document.body.replaceChildren()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
async function mount() {
	root = createRoot(host)
	// No management client is provided: document controls must use the reader's local clear,
	// never obtain a backend mutation capability of their own.
	await act(async () =>
		root!.render(
			<MantineProvider env="test">
				<WorkbenchNavigationProvider value={{ navigate: vi.fn(), openTab: vi.fn() }}>
					<LogsPage search={{}} />
				</WorkbenchNavigationProvider>
			</MantineProvider>,
		),
	)
}
async function click(text: string) {
	const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text)
	expect(button, `button ${text}`).toBeDefined()
	await act(async () => button!.click())
}
const details = () => host.querySelector('[aria-label="关闭日志详情"]')
const following = () => host.querySelector('[aria-label="日志列表"]')?.getAttribute('data-follow')

describe('log document reading interactions', () => {
	it('opens details on demand and drops the old record when epoch or boot changes', async () => {
		await mount()
		expect(details()).toBeNull()
		await click('message-1')
		expect(details()).not.toBeNull()
		expect(host.textContent).toContain('retained-detail')
		for (const next of [
			{ epoch: 2, bootId: 'first' },
			{ epoch: 2, bootId: 'restarted' },
		]) {
			const message = `${next.bootId}-${next.epoch}`
			await act(async () => {
				stream.meta = { ...meta, ...next }
				store.clear()
				store.append([line(1, next.epoch, message)])
			})
			expect(details()).toBeNull()
			expect(host.textContent).not.toContain('retained-detail')
			await click(message)
			expect(details()).not.toBeNull()
		}
	})

	it('keeps paused reading and details while new rows arrive, then resumes or clears only this display', async () => {
		await mount()
		await click('message-1')
		await click('暂停跟随')
		expect(following()).toBe('false')
		await act(async () => store.append([line(2)]))
		expect(details()).not.toBeNull()
		expect(host.textContent).toContain('已暂停跟随')
		expect(host.textContent).toContain('message-2')
		await click('回到最新 · 有新日志')
		expect(following()).toBe('true')
		await click('清空显示')
		expect(stream.clear).toHaveBeenCalledOnce()
		expect(stream.retry).not.toHaveBeenCalled()
		expect(store.length).toBe(0)
		expect(details()).toBeNull()
		await act(async () => store.append([line(3)]))
		expect(host.textContent).toContain('message-3')
		expect(following()).toBe('true')
	})
})
