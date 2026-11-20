// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	SortableRow,
	type SortableRowProps,
} from '../src/app/plugins/catalog/organizer/components/SortableRow'
import { DENSITY } from '../src/app/plugins/catalog/organizer/constants'
import { SearchBar } from '../src/app/plugins/catalog/components/SearchBar'

const roots: Root[] = []
const name = 'AccountManagementPlugin'
const pid = 'v1/package/AccountManagementPlugin/@fixture/accounts'
const meta = {
	definition: '@fixture/accounts',
	exportName: 'AccountManagementPlugin',
	reference: 'package:@fixture/accounts::AccountManagementPlugin',
	executionLabel: '宿主重载',
	executionTone: 'blue' as const,
	executionDescription: '静态插件目录 · 构建模块；应用模块图变化时更新',
}
const props: SortableRowProps = {
	pid,
	name,
	running: true,
	available: true,
	selected: false,
	active: false,
	focused: false,
	onSelect: vi.fn(),
	dragDisabled: false,
	dh: DENSITY.ultra,
	meta,
	sortableId: pid,
}

beforeAll(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	window.matchMedia = vi.fn().mockImplementation((media: string) => ({
		media,
		matches: false,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}))
})

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	vi.clearAllMocks()
})

async function mount(content: ReactNode) {
	const container = document.body.appendChild(document.createElement('div'))
	container.style.width = '260px'
	const root = createRoot(container)
	roots.push(root)
	await act(async () => {
		root.render(<MantineProvider env="test">{content}</MantineProvider>)
	})
	return container
}

describe('plugin catalog controls', () => {
	it('keeps selection separate from the name link and exposes status and diagnostics on the compact row', async () => {
		const container = await mount(
			<SortableRow {...props} meta={{ ...meta, recentUpdateWarningLabel: '上次更新失败' }} />,
		)
		const row = container.querySelector('[role="listitem"]')!
		const link = row.querySelector<HTMLAnchorElement>('a')!
		const execution = row.querySelector<HTMLElement>('[aria-label="宿主重载"]')!
		expect(row.textContent).toBe(name)
		expect(link.getAttribute('href')).toBe(`/plugins/${pid}`)
		expect(row.querySelector('[aria-label="运行中"]')).not.toBeNull()
		expect(row.querySelector('[aria-label="上次更新失败"]')).not.toBeNull()
		await act(async () =>
			row.querySelector<HTMLButtonElement>(`[aria-label="选择 ${name}"]`)!.click(),
		)
		expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(expect.anything(), pid, 'toggle')
		await act(async () => link.focus())
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(name)
		await act(async () => execution.focus())
		const tooltips = [...document.querySelectorAll('[role="tooltip"]')]
		expect(tooltips.map((tooltip) => tooltip.textContent?.trim())).toContainEqual(
			expect.stringContaining(meta.executionDescription),
		)
	})

	it('exposes status totals and gives status filtering and search clearing separate actions', async () => {
		const change = vi.fn()
		const toggle = vi.fn()
		const reset = vi.fn()
		const container = await mount(
			<SearchBar
				value="runtime"
				onChange={change}
				inputRef={createRef<HTMLInputElement>()}
				statusFilter={{ running: true, stopped: false, unavailable: true }}
				statusCounts={{ running: 2, stopped: 11, unavailable: 1 }}
				onToggleStatus={toggle}
				onResetStatusFilter={reset}
				hasActiveStatusFilter
			/>,
		)
		const control = (label: string) =>
			container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
		expect(control('运行中 2 个').getAttribute('aria-pressed')).toBe('true')
		const stopped = control('已停止 11 个')
		expect(stopped.getAttribute('aria-pressed')).toBe('false')
		expect(control('不可用 1 个').getAttribute('aria-pressed')).toBe('true')
		await act(async () => stopped.click())
		expect(toggle).toHaveBeenCalledExactlyOnceWith('stopped')
		await act(async () => control('清空搜索').click())
		expect(change).toHaveBeenCalledExactlyOnceWith('')
		expect(reset).not.toHaveBeenCalled()
		await act(async () => control('恢复全部状态筛选').click())
		expect(reset).toHaveBeenCalledOnce()
	})
})
