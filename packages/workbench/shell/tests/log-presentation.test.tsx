// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeLogLine } from '../src/runtime'
import { LogRow } from '../src/app/log_viewer/LogRow'
import { LogList } from '../src/app/log_viewer/LogList'
import { LogDetails } from '../src/app/log_viewer/LogDetails'
import {
	messageToText,
	renderAnsi,
	stripAnsi,
	serializeLogValue,
} from '../src/app/log_viewer/logFormatting'

vi.mock('../src/theme', () => ({
	useThemeModel: () => ({
		log: {
			listStripe: 'transparent',
			levels: { info: 'blue', default: 'gray' },
			rowSelectedBg: 'silver',
			ansi16: ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'],
		},
	}),
}))
const line: RuntimeLogLine = {
	streamId: 'default',
	epoch: 1,
	seq: '1',
	ts: 1000,
	level: 'info',
	category: ['plugin', 'test'],
	msg: 'hello\nworld',
	props: { count: 3 },
	raw: { source: 'test' },
}
let root: Root | undefined
let host: HTMLDivElement
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	}))
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(240)
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(240)
	host = document.createElement('div')
	document.body.append(host)
})
afterEach(async () => {
	if (root) await act(async () => root!.unmount())
	root = undefined
	host.remove()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})
async function mount(view: ReactNode) {
	root = createRoot(host)
	await act(async () => root!.render(<MantineProvider>{view}</MantineProvider>))
}
it('renders ANSI as escaped React text and removes OSC hyperlinks with BEL or ST endings', () => {
	const text =
		'\x1b]8;;https://example.test\x1b\\<img src=x onerror=alert(1)>\x1b]8;;\x07\x1b[31mred\x1b[0m'
	expect(stripAnsi(text)).toBe('<img src=x onerror=alert(1)>red')
	const markup = renderToStaticMarkup(<>{renderAnsi(text, ['black', 'red'])}</>)
	expect(markup).toContain('&lt;img')
	expect(markup).not.toContain('<img')
	expect(markup).not.toContain('https://example.test')
	expect(markup).toContain('color:red')
})
it('formats structured message values without failing on bigint or circular payloads', () => {
	const circular: Record<string, unknown> = { count: 3n }
	circular.self = circular
	expect(() => messageToText({ ...line, msg: '', message: ['payload ', circular] })).not.toThrow()
	expect(serializeLogValue(circular)).toContain('[Circular]')
})
it('uses a non-interactive preview and a selectable full row', async () => {
	const select = vi.fn()
	await mount(
		<>
			<LogRow line={line} preview onSelect={select} />
			<LogRow line={line} onSelect={select} />
		</>,
	)
	expect(host.querySelectorAll('button')).toHaveLength(1)
	expect(host.textContent).toContain('hello⏎world')
	await act(async () => host.querySelector('button')!.click())
	expect(select).toHaveBeenCalledWith(line)
})
it('renders only the virtual window of a large store and never materializes the buffer', async () => {
	const get = vi.fn((index: number) => ({ ...line, seq: String(index) }))
	const toArray = vi.fn(() => {
		throw new Error('full buffer scan')
	})
	const store = { get, length: 50000, getVersion: () => 1, subscribe: () => () => {}, toArray }
	await mount(<LogList store={store} onSelect={vi.fn()} follow={false} onFollowChange={vi.fn()} />)
	expect(host.querySelectorAll('button').length).toBeGreaterThan(0)
	expect(host.querySelectorAll('button').length).toBeLessThan(100)
	expect(get.mock.calls.length).toBeLessThan(100)
	expect(toArray).not.toHaveBeenCalled()
})
it('shows structured details and forwards close', async () => {
	const close = vi.fn()
	await mount(<LogDetails line={line} onClose={close} />)
	expect(host.textContent).toContain('复制文本')
	expect(host.textContent).toContain('复制 JSON')
	expect(host.textContent).toContain('属性')
	expect(host.textContent).toContain('原始记录')
	await act(async () =>
		host.querySelector<HTMLButtonElement>('[aria-label="关闭日志详情"]')!.click(),
	)
	expect(close).toHaveBeenCalledOnce()
})
