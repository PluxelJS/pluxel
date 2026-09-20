// @vitest-environment jsdom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchStatePersistence } from '../src/app/workbench/shell/WorkbenchStatePersistence'
import { createPersistedWorkbenchState, WORKBENCH_STORAGE_KEY } from '../src/app/workbench/state'
import { WorkspaceController } from '../src/app/workbench/store'

const mounted = new Set<Root>()

beforeEach(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	vi.useFakeTimers()
	vi.stubGlobal('requestIdleCallback', undefined)
	vi.stubGlobal('cancelIdleCallback', undefined)
	window.localStorage.clear()
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted) root.unmount()
	})
	mounted.clear()
	document.body.replaceChildren()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

async function mount(strict = false) {
	const controller = new WorkspaceController('/logs')
	const root = createRoot(document.body.appendChild(document.createElement('div')))
	mounted.add(root)
	await act(async () => {
		const content = <WorkbenchStatePersistence controller={controller} />
		root.render(strict ? <StrictMode>{content}</StrictMode> : content)
	})
	return { controller, root }
}

const savedState = () => JSON.parse(window.localStorage.getItem(WORKBENCH_STORAGE_KEY)!)

describe('Workbench state persistence', () => {
	it('coalesces UI changes into the latest snapshot and ignores transient dirty markers', async () => {
		const write = vi.spyOn(Storage.prototype, 'setItem')
		const { controller } = await mount()
		controller.toggleNavigationCollapsed()
		controller.togglePluginPane()
		controller.openTab({ path: '/security', title: 'Security' })
		expect(write).not.toHaveBeenCalled()
		vi.advanceTimersByTime(120)
		expect(write).toHaveBeenCalledTimes(1)
		expect(savedState()).toEqual(createPersistedWorkbenchState(controller.state.uiState))
		controller.setTabDirty(controller.activeTab!.instanceId, true)
		vi.runAllTimers()
		expect(write).toHaveBeenCalledTimes(1)
		expect(savedState()).not.toHaveProperty('dirtyTabs')
	})

	it.each(['pagehide', 'visibilitychange', 'unmount'] as const)(
		'flushes pending state on %s and cancels delayed writes',
		async (event) => {
			const write = vi.spyOn(Storage.prototype, 'setItem')
			const { controller, root } = await mount()
			controller.togglePluginPane()
			if (event === 'unmount') {
				await act(async () => {
					root.unmount()
				})
				mounted.delete(root)
			} else if (event === 'visibilitychange') {
				vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
				document.dispatchEvent(new Event(event))
			} else {
				window.dispatchEvent(new Event(event))
			}
			expect(write).toHaveBeenCalledTimes(1)
			expect(savedState()).toEqual(createPersistedWorkbenchState(controller.state.uiState))
			vi.runAllTimers()
			expect(write).toHaveBeenCalledTimes(1)
			if (mounted.delete(root)) {
				await act(async () => {
					root.unmount()
				})
			}
			controller.togglePluginPane()
			window.dispatchEvent(new Event('pagehide'))
			vi.runAllTimers()
			expect(write).toHaveBeenCalledTimes(1)
		},
	)

	it('uses one bounded idle callback for a burst of changes', async () => {
		const request = vi.fn((callback: IdleRequestCallback) =>
			window.setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), 240),
		)
		const cancel = vi.fn((handle: number) => window.clearTimeout(handle))
		vi.stubGlobal('requestIdleCallback', request)
		vi.stubGlobal('cancelIdleCallback', cancel)
		const write = vi.spyOn(Storage.prototype, 'setItem')
		const { controller } = await mount()
		controller.toggleNavigationCollapsed()
		controller.togglePluginPane()
		expect(request).toHaveBeenCalledTimes(1)
		expect(request).toHaveBeenCalledWith(expect.any(Function), { timeout: 240 })
		vi.advanceTimersByTime(240)
		expect(write).toHaveBeenCalledTimes(1)
		expect(savedState()).toEqual(createPersistedWorkbenchState(controller.state.uiState))
	})

	it('does not repeat identical writes after StrictMode replay or reverted UI changes', async () => {
		const write = vi.spyOn(Storage.prototype, 'setItem')
		const { controller } = await mount(true)
		vi.runAllTimers()
		expect(write).toHaveBeenCalledTimes(1)
		controller.togglePluginPane()
		controller.togglePluginPane()
		vi.runAllTimers()
		expect(write).toHaveBeenCalledTimes(1)
	})

	it('keeps working when storage is unavailable and saves the next change when it recovers', async () => {
		const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
			throw new Error('storage unavailable')
		})
		const { controller } = await mount()
		expect(() => vi.runAllTimers()).not.toThrow()
		controller.togglePluginPane()
		vi.runAllTimers()
		expect(write).toHaveBeenCalledTimes(2)
		expect(savedState()).toEqual(createPersistedWorkbenchState(controller.state.uiState))
	})
})
