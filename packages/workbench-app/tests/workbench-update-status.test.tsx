import type { RuntimeUpdateSnapshot } from '@pluxel/runtime/web'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
	mode: 'development',
	snapshot: null as RuntimeUpdateSnapshot | null,
}))
vi.mock('../src/app/runtimeUpdates', () => ({
	useRuntimeUpdates: () => ({ snapshot: state.snapshot, ready: true, error: null }),
}))
vi.mock('../src/app/product', () => ({
	useRuntimeMeta: () => ({ platform: { mode: state.mode } }),
}))
vi.mock('@mantine/core', () => {
	const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>
	return {
		Badge: Box,
		Button: Box,
		Group: Box,
		Stack: Box,
		Text: Box,
		Popover: Object.assign(Box, { Target: Box, Dropdown: Box }),
	}
})
import { WorkbenchUpdateStatus } from '../src/app/workbench/shell/WorkbenchUpdateStatus'

beforeEach(() => {
	state.mode = 'development'
	state.snapshot = null
})

describe('Workbench update status semantics', () => {
	it('does not advertise HMR monitoring on a production host without update records', () => {
		state.mode = 'production'
		expect(renderToStaticMarkup(<WorkbenchUpdateStatus />)).toBe('')
	})
	it('distinguishes accepted runtime batches from producer availability', () => {
		state.snapshot = {
			sequence: 1,
			state: 'settled',
			phase: null,
			outcome: 'applied',
			durationMs: 12,
			trigger: null,
			error: null,
		}
		const markup = renderToStaticMarkup(<WorkbenchUpdateStatus />)
		expect(markup).toContain('HMR 已应用')
		expect(markup).toContain('界面产物就绪后会自动载入')
	})
	it('only promises the previous version remains available during candidate preparation', () => {
		state.snapshot = {
			sequence: 1,
			state: 'updating',
			phase: 'evaluate',
			outcome: null,
			durationMs: 0,
			trigger: null,
			error: null,
		}
		expect(renderToStaticMarkup(<WorkbenchUpdateStatus />)).toContain('当前版本继续提供服务')
		state.snapshot = { ...state.snapshot, phase: 'commit' }
		const markup = renderToStaticMarkup(<WorkbenchUpdateStatus />)
		expect(markup).toContain('正在切换运行版本')
		expect(markup).not.toContain('当前版本继续提供服务')
	})
})
