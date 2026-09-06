// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PluginRuntimeSummaryCard } from '../src/app/plugins/detail/cards/PluginRuntimeSummaryCard'
import type { PluginStatusEntry } from '../src/app/plugins/pluginOverview'

const status: PluginStatusEntry = {
	address: {
		definition: {
			entry: { kind: 'package-root', packageName: '@fixture/tools' },
			exportName: 'ToolsPlugin',
		},
		variant: 'default',
	},
	id: 'v1/package/ToolsPlugin/@fixture/tools',
	route: 'v1/package/ToolsPlugin/@fixture/tools',
	reference: 'untrusted display reference',
	displayName: 'Tools',
	label: 'Tools',
	rootExportName: 'ToolsPlugin',
	autoStart: true,
	sessionIntent: 'inherit',
	desiredState: 'running',
	activationReason: 'auto-start',
	lifecycleState: 'running',
	availability: 'available',
	issues: [],
	execution: {
		kind: 'static-catalog',
		artifact: { kind: 'built-module' },
		update: { kind: 'catalog-hmr' },
	},
	recentUpdate: null,
}

const mounted: Root[] = []
const writeText = vi.fn().mockResolvedValue(undefined)

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
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
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	writeText.mockClear()
})

async function mount(initial: PluginStatusEntry = status) {
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	mounted.push(root)
	const render = async (value: PluginStatusEntry) => {
		await act(async () => {
			root.render(
				<MantineProvider env="test">
					<PluginRuntimeSummaryCard status={value} />
				</MantineProvider>,
			)
		})
	}
	await render(initial)
	return { container, render }
}

describe('plugin runtime summary', () => {
	it('defaults to status and source, with detailed diagnostics collapsed and no empty placeholders', async () => {
		const { container } = await mount()
		const details = container.querySelector('details')!
		expect(details.open).toBe(false)
		expect(details.querySelector('summary')?.textContent).toBe('调试信息')
		const summaryRows = [...container.querySelectorAll('.plx-pluginWorkbench__summaryRow')].filter(
			(row) => !details.contains(row),
		)
		expect(summaryRows.map((row) => row.textContent)).toEqual(['状态运行中', '来源@fixture/tools'])
		expect(container.textContent).not.toContain('暂无描述')
		expect(container.textContent).not.toContain('本进程暂无更新记录')
		expect(details.textContent).toContain('构建模块')
		expect(details.textContent).toContain('package:@fixture/tools::ToolsPlugin')
	})

	it.each([
		{ outcome: 'retained-previous', phase: 'evaluate', label: '更新失败 · 已保留上一版本' },
		{ outcome: 'applied-with-issues', phase: 'lifecycle', label: '新版本已提交 · 生命周期异常' },
		{ outcome: 'applied-with-issues', phase: 'commit', label: '新版本已提交 · 提交后异常' },
		{
			outcome: 'restored-previous',
			phase: 'application-reload',
			label: '应用重载失败 · 已用上一应用定义恢复',
		},
	] as const)(
		'keeps $outcome / $phase and runtime issues visible outside diagnostics',
		async ({ label, ...update }) => {
			const { container } = await mount({
				...status,
				recentUpdate: { ...update, sequence: 3, durationMs: 12 },
				issues: [{ id: 'missing', code: 'missing_required_provider', message: '缺少必需依赖' }],
			})
			const warning = container.querySelector('[role="status"]')!
			expect(container.querySelector('details')?.open).toBe(false)
			expect(warning.closest('details')).toBeNull()
			expect(warning.textContent).toBe(label)
			const issue = [...container.querySelectorAll('p')].find(
				(element) => element.textContent === '缺少必需依赖',
			)!
			expect(issue).toBeDefined()
			expect(issue.closest('details')).toBeNull()
		},
	)

	it('copies the canonical reference and bounded diagnosis without display text or raw issue messages', async () => {
		const current: PluginStatusEntry = {
			...status,
			recentUpdate: { outcome: 'applied', phase: null, sequence: 4, durationMs: 8 },
			issues: [
				{
					id: 'missing',
					code: 'missing_required_provider',
					message: 'diagnostic detail omitted from copy',
				},
			],
		}
		const { container } = await mount(current)
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[aria-label="复制插件引用"]')!.click()
		})
		expect(writeText).toHaveBeenLastCalledWith('package:@fixture/tools::ToolsPlugin')
		const details = container.querySelector('details')!
		await act(async () => {
			details.querySelector('summary')!.click()
		})
		expect(details.open).toBe(true)
		await act(async () => {
			details.querySelector<HTMLButtonElement>('button')!.click()
		})
		expect(JSON.parse(writeText.mock.lastCall![0])).toEqual({
			reference: 'package:@fixture/tools::ToolsPlugin',
			execution: current.execution,
			recentUpdate: current.recentUpdate,
			autoStart: true,
			sessionIntent: 'inherit',
			desiredState: 'running',
			activationReason: 'auto-start',
			lifecycleState: 'running',
			availability: 'available',
			issueCodes: ['missing_required_provider'],
		})
	})

	it('keeps expansion across status refreshes but resets it for a different node', async () => {
		const { container, render } = await mount()
		const details = container.querySelector('details')!
		await act(async () => {
			details.querySelector('summary')!.click()
		})
		await render({ ...status, sessionIntent: 'run' })
		expect(container.querySelector('details')).toBe(details)
		expect(details.open).toBe(true)
		await render({ ...status, address: { ...status.address, variant: 'fork', forkId: 'other' } })
		expect(container.querySelector('details')).not.toBe(details)
		expect(container.querySelector('details')?.open).toBe(false)
	})
})
