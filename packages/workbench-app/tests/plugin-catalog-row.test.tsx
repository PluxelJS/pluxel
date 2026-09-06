// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	SortableRow,
	type SortableRowProps,
} from '../src/app/plugins/catalog/organizer/components/SortableRow'
import { GroupCard } from '../src/app/plugins/catalog/organizer/components/GroupCard'
import { DENSITY } from '../src/app/plugins/catalog/organizer/constants'

const roots: Root[] = []
const name = 'AccountManagementPlugin'
const pid = 'v1/package/AccountManagementPlugin/@fixture/accounts'
const meta = {
	definition: '@fixture/accounts',
	exportName: 'AccountManagementPlugin',
	reference: 'package:@fixture/accounts::AccountManagementPlugin',
	executionLabel: '目录 HMR',
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

function Link({ to, children, ...rest }: { to: string } & ComponentProps<'a'>) {
	return (
		<a href={to} {...rest}>
			{children}
		</a>
	)
}

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

describe('compact plugin catalog rows', () => {
	it.each(Object.entries(DENSITY))(
		'reserves visible text for the plugin name at %s density',
		async (_density, dh) => {
			const container = await mount(<SortableRow {...props} dh={dh} />)
			const row = container.querySelector('[data-plugin-row]')!
			expect(row.textContent).toBe(name)
			expect(row.querySelector('.mantine-Badge-root')).toBeNull()
			expect(row.querySelector('[aria-label="目录 HMR"]')).not.toBeNull()
			expect(row.querySelector('[aria-label="运行中"]')).not.toBeNull()
			expect(row.querySelector<HTMLAnchorElement>('[data-plugin-link]')?.style.flexGrow).toBe('1')
		},
	)

	it('gives routed plugin names the available width and preserves selection controls', async () => {
		const container = await mount(<SortableRow {...props} LinkComp={Link} />)
		const link = container.querySelector<HTMLAnchorElement>('[data-plugin-link]')!
		expect(link.textContent).toBe(name)
		expect(link.style.flexGrow).toBe('1')
		expect(link.style.minWidth).toBe('0px')
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[data-row-selector]')!.click()
		})
		expect(props.onSelect).toHaveBeenCalledWith(expect.anything(), pid, 'toggle')
		expect(container.querySelector('[data-drag-handle]')).not.toBeNull()
	})

	it('reveals complete execution details when the indicator receives keyboard focus', async () => {
		const container = await mount(<SortableRow {...props} />)
		await act(async () => {
			container.querySelector<HTMLElement>('[aria-label="目录 HMR"]')!.focus()
		})
		expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
			meta.executionDescription,
		)
	})

	it('lays out the full name, source, export, status, update mode, and reference on focus', async () => {
		const container = await mount(<SortableRow {...props} />)
		await act(async () => {
			container.querySelector<HTMLElement>('[data-plugin-link]')!.focus()
		})
		const tooltip = document.querySelector('[role="tooltip"]')!
		expect(tooltip.querySelector('.plx-pluginCatalog__hoverTitle')?.textContent).toBe(name)
		expect(tooltip.querySelector('.plx-pluginCatalog__hoverFacts')?.textContent).toContain(
			`来源${meta.definition}导出${meta.exportName}状态运行中更新${meta.executionLabel}`,
		)
		expect(tooltip.querySelector('.plx-pluginCatalog__hoverReference')?.textContent).toBe(
			meta.reference,
		)
	})

	it('keeps update warnings discoverable as an icon without adding another text badge', async () => {
		const container = await mount(
			<SortableRow {...props} meta={{ ...meta, recentUpdateWarningLabel: '上次更新失败' }} />,
		)
		expect(container.querySelector('[aria-label="上次更新失败"] svg')).not.toBeNull()
		expect(container.querySelector('[data-plugin-row]')?.textContent).toBe(name)
	})

	it('shows only an unbadged group count, retaining running totals in the tooltip', async () => {
		const container = await mount(
			<GroupCard
				g={{ groupId: 'accounts', name: '@fixture/accounts', pluginIds: [pid] }}
				visibleIds={[pid]}
				runningSet={new Set([pid])}
				availableSet={new Set([pid])}
				desiredRunningSet={new Set([pid])}
				selectedSet={new Set()}
				activeSet={new Set()}
				focusedId={null}
				onSelect={vi.fn()}
				sortableId="accounts"
				droppableId="accounts-drop"
				isFiltering={false}
				isCollapsed
				toggleCollapse={vi.fn()}
				getName={() => name}
				getMeta={() => meta}
				getItemSortableId={(id) => id}
				dh={DENSITY.ultra}
				locked={false}
			/>,
		)
		expect(container.querySelector('.mantine-Badge-root')).toBeNull()
		expect(container.querySelector('[aria-label="运行中 1 / 共 1 个插件"]')?.textContent).toBe('1')
	})
})
