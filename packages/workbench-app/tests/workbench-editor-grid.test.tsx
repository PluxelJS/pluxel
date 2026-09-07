// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	WorkbenchEditorGrid,
	type EditorGridGroup,
	type EditorGridLayout,
} from '../src/app/workbench/split/view'

const mounted: Array<ReturnType<typeof createRoot>> = []

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	globalThis.ResizeObserver = class {
		constructor(private readonly callback: ResizeObserverCallback) {}
		observe(target: Element) {
			this.callback(
				[
					{
						target,
						contentRect: { width: 960, height: 640 },
					} as ResizeObserverEntry,
				],
				this as unknown as ResizeObserver,
			)
		}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

const groups: readonly EditorGridGroup[] = [
	{
		id: 'left',
		activeTabId: 'left-tab',
		tabs: [
			{
				id: 'left-tab',
				title: 'Left',
				renderLabel: () => 'Left',
				renderContent: () => 'Left content',
			},
		],
	},
	{
		id: 'right',
		activeTabId: 'right-tab',
		tabs: [
			{
				id: 'right-tab',
				title: 'Right',
				renderLabel: () => 'Right',
				renderContent: () => 'Right content',
			},
		],
	},
]

const horizontalLayout: EditorGridLayout = {
	type: 'split',
	id: 'root',
	orientation: 'horizontal',
	children: [
		{ node: { type: 'group', groupId: 'left' } },
		{ node: { type: 'group', groupId: 'right' } },
	],
}

function renderGrid(
	root: ReturnType<typeof createRoot>,
	options: { layout: EditorGridLayout; maximizedGroupId?: string },
) {
	root.render(
		<WorkbenchEditorGrid
			groups={groups}
			layout={options.layout}
			maximizedGroupId={options.maximizedGroupId}
			onActiveTabsChange={vi.fn()}
			onFocusGroup={vi.fn()}
			onLayoutCommit={vi.fn()}
		/>,
	)
}

describe('Workbench editor-grid adapter', () => {
	it('drives temporary maximization and topology from props instead of restoration commands', async () => {
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		await act(async () => renderGrid(root, { layout: horizontalLayout, maximizedGroupId: 'left' }))
		expect(container.querySelectorAll('.worksplit-workbench-editor-maximized-hidden')).toHaveLength(
			1,
		)

		await act(async () => renderGrid(root, { layout: horizontalLayout }))
		expect(container.querySelector('.worksplit-workbench-editor-maximized-hidden')).toBeNull()

		const verticalLayout: EditorGridLayout = {
			...horizontalLayout,
			orientation: 'vertical',
		}
		await act(async () => renderGrid(root, { layout: verticalLayout }))
		expect(
			container
				.querySelector('.worksplit-workbench-editor-groups')
				?.getAttribute('data-orientation'),
		).toBe('vertical')
	})
})
