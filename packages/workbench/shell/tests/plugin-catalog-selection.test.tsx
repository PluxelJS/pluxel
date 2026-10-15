// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { usePluginSelectionController } from '../src/app/plugins/catalog/organizer/usePluginSelectionController'

let root: Root
let host: HTMLDivElement
let selection: ReturnType<typeof usePluginSelectionController>
const move = vi.fn()
const groups = [
	{ groupId: 'hidden', name: 'Hidden', pluginIds: ['b', 'c'] },
	{ groupId: 'visible', name: 'Visible', pluginIds: ['d', 'e'] },
]
function Fixture() {
	selection = usePluginSelectionController({
		activeId: null,
		allIds: ['a', 'b', 'c', 'd', 'e'],
		visibleGroups: groups,
		collapsedGroups: { hidden: true },
		ungroupedDisplayOrder: ['a'],
		onMoveSelection: move,
		onMoveToUngrouped: vi.fn(),
		locked: false,
	})
	return (
		<div
			role="listbox"
			aria-label="插件"
			ref={selection.containerRef}
			tabIndex={0}
			onKeyDown={selection.handleKeyDown}
		>
			<button type="button" onClick={move}>
				展开分组
			</button>
			<a href="#plugin">插件</a>
		</div>
	)
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	host = document.createElement('div')
	document.body.append(host)
	root = createRoot(host)
	move.mockClear()
	await act(async () => root.render(<Fixture />))
})
afterEach(async () => {
	await act(async () => root.unmount())
	host.remove()
})
async function key(target: Element, pressedKey: string, init: KeyboardEventInit = {}) {
	const event = new KeyboardEvent('keydown', {
		key: pressedKey,
		bubbles: true,
		cancelable: true,
		...init,
	})
	await act(async () => {
		target.dispatchEvent(event)
	})
	return event
}
it('skips collapsed rows for keyboard focus, range selection and select all', async () => {
	const list = host.firstElementChild!
	await key(list, 'Home')
	await key(list, 'ArrowDown', { shiftKey: true })
	expect(selection.focusedId).toBe('d')
	expect(selection.selectedIds).toEqual(['a', 'd'])
	await key(list, 'a', { ctrlKey: true })
	expect(selection.selectedIds).toEqual(['a', 'd', 'e'])
})
it('leaves button and link Enter/Space to their own native interaction', async () => {
	for (const element of [host.querySelector('button')!, host.querySelector('a')!]) {
		for (const name of ['Enter', ' ']) {
			const event = await key(element, name)
			expect(event.defaultPrevented).toBe(false)
		}
	}
	expect(selection.selectedIds).toEqual([])
})
