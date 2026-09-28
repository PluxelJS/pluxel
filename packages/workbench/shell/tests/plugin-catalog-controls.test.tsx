import { MantineProvider } from '@mantine/core'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { SearchBar } from '../src/app/plugins/catalog/components/SearchBar'

describe('plugin catalog controls', () => {
	it('keeps status totals available without rendering a persistent statistics row', () => {
		const markup = renderToStaticMarkup(
			<MantineProvider>
				<SearchBar
					value=""
					onChange={vi.fn()}
					inputRef={createRef<HTMLInputElement>()}
					statusFilter={{ running: true, stopped: true, unavailable: true }}
					statusCounts={{ running: 2, stopped: 11, unavailable: 1 }}
					onToggleStatus={vi.fn()}
					onResetStatusFilter={vi.fn()}
					hasActiveStatusFilter={false}
				/>
			</MantineProvider>,
		)

		expect(markup).toContain('placeholder="搜索名称 / @包 / ref: / exec:"')
		expect(markup).toContain('title="运行中 2 个 · Alt+1"')
		expect(markup).toContain('title="已停止 11 个 · Alt+2"')
		expect(markup).toContain('title="不可用 1 个 · Alt+3"')
		expect(markup).not.toContain('恢复全部状态')
	})

	it('does not duplicate search clearing with a full reset button', () => {
		const markup = renderToStaticMarkup(
			<MantineProvider>
				<SearchBar
					value="runtime"
					onChange={vi.fn()}
					inputRef={createRef<HTMLInputElement>()}
					statusFilter={{ running: true, stopped: true, unavailable: true }}
					statusCounts={{ running: 1, stopped: 0, unavailable: 0 }}
					onToggleStatus={vi.fn()}
					onResetStatusFilter={vi.fn()}
					hasActiveStatusFilter={false}
				/>
			</MantineProvider>,
		)

		expect(markup).toContain('title="清空搜索"')
		expect(markup).not.toContain('恢复全部状态')
	})
})
