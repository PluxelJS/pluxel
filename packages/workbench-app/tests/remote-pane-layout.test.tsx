// @vitest-environment jsdom

import { act, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	WorkbenchPane,
	WorkbenchPaneLayout,
	type WorkbenchPaneProps,
} from '@pluxel/runtime/workbench/ui'
import {
	WorkbenchViewProvider,
	type WorkbenchPaneDescriptor,
	type WorkbenchViewState,
} from '@pluxel/runtime/workbench/ui/internal'
import {
	HostRemotePaneLayout,
	RemotePaneLayoutStateProvider,
	sanitizeRemotePaneState,
} from '../src/app/workbench/RemotePaneLayout'

const mounted: Array<ReturnType<typeof createRoot>> = []
const pane = (props: WorkbenchPaneProps) => <WorkbenchPane {...props} />
let observedWidth = 1_400
let resizeCallback: (() => void) | undefined

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	class TestResizeObserver {
		constructor(callback: (entries: readonly ResizeObserverEntry[]) => void) {
			resizeCallback = () =>
				callback([{ contentRect: { width: observedWidth, height: 700 } } as ResizeObserverEntry])
		}
		observe() {
			resizeCallback?.()
		}
		disconnect() {}
	}
	globalThis.ResizeObserver = TestResizeObserver as never
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get: () => observedWidth,
	})
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	observedWidth = 1_400
	resizeCallback = undefined
})

describe('remote Pane Kit host renderer', () => {
	it('keeps pane children mounted while crossing wide, medium, and compact modes', async () => {
		const mounts = vi.fn()
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		function StatefulProbe() {
			const [value, setValue] = useState('draft')
			useEffect(() => {
				mounts()
			}, [])
			return (
				<input
					aria-label="draft"
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
				/>
			)
		}

		await act(async () => {
			root.render(
				<Fixture>
					<StatefulProbe />
				</Fixture>,
			)
		})
		const input = container.querySelector<HTMLInputElement>('[aria-label="draft"]')!
		input.value = 'unsaved'
		input.dispatchEvent(new Event('input', { bubbles: true }))

		for (const width of [900, 390, 1_400]) {
			observedWidth = width
			await act(async () => resizeCallback?.())
		}

		const paneWidths = [
			...container.querySelectorAll<HTMLElement>('.plx-remotePaneLayout__paneHost'),
		]
			.filter((host) => host.querySelector('[data-role="navigation"], [data-role="inspector"]'))
			.map((host) => Number.parseFloat(host.style.width))
		expect(mounts).toHaveBeenCalledTimes(1)
		expect(container.querySelector<HTMLInputElement>('[aria-label="draft"]')?.value).toBe('unsaved')
		expect(paneWidths).toHaveLength(2)
		expect(paneWidths.every((width) => width > 0)).toBe(true)
	})

	it('allows only one responsive drawer and closes it with Escape', async () => {
		observedWidth = 390
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)
		await act(async () =>
			root.render(
				<Fixture>
					<span>main</span>
				</Fixture>,
			),
		)

		const scenario = container.querySelector<HTMLButtonElement>(
			'button[aria-expanded][type="button"]',
		)!
		const inspection = [
			...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'),
		][1]!
		await act(async () => scenario.click())
		expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Scenario')
		await act(async () => inspection.click())
		expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1)
		expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
			'Inspection',
		)
		await act(async () => {
			container
				.querySelector('[role="dialog"]')
				?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
		})
		expect(container.querySelector('[role="dialog"]')).toBeNull()
	})

	it('uses memory state in standalone and writes only when a host state service exists', async () => {
		observedWidth = 1_400
		const hostState = stateService()
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)
		await act(async () =>
			root.render(
				<Fixture hostState={hostState.api}>
					<span>main</span>
				</Fixture>,
			),
		)
		await act(async () =>
			container.querySelector<HTMLButtonElement>('[aria-label="Close Scenario"]')?.click(),
		)
		expect(hostState.write).toHaveBeenCalledTimes(1)

		const standaloneContainer = document.createElement('div')
		document.body.appendChild(standaloneContainer)
		const standaloneRoot = createRoot(standaloneContainer)
		mounted.push(standaloneRoot)
		await act(async () =>
			standaloneRoot.render(
				<Fixture>
					<span>main</span>
				</Fixture>,
			),
		)
		await act(async () =>
			standaloneContainer
				.querySelector<HTMLButtonElement>('[aria-label="Close Scenario"]')
				?.click(),
		)
		expect(hostState.write).toHaveBeenCalledTimes(1)
	})

	it('rejects malformed restored percentages and forces primary visibility', () => {
		const panes = descriptors()
		expect(
			sanitizeRemotePaneState(
				{
					version: 1,
					layout: { scenario: -1, main: 150, inspection: 25, foreign: 10 },
					visibility: { scenario: false, main: false, inspection: true },
				},
				panes,
			),
		).toEqual({
			version: 1,
			layout: { inspection: 25 },
			visibility: { scenario: false, main: true, inspection: true },
		})
	})
})

function Fixture({
	children,
	hostState,
	locale = 'en',
}: {
	children: ReactNode
	hostState?: WorkbenchViewState
	locale?: string
}) {
	return (
		<RemotePaneLayoutStateProvider state={hostState}>
			<WorkbenchViewProvider
				item={{ ownerPluginId: 'Owner', targetPluginId: 'Target' } as never}
				environment={{ locale: { locale, subscribe: () => () => {} } } as never}
				paneLayoutRenderer={HostRemotePaneLayout}
			>
				<WorkbenchPaneLayout id="fixture">
					{pane({ id: 'scenario', role: 'navigation', title: 'Scenario', children: 'scenario' })}
					{pane({ id: 'main', role: 'primary', title: 'Main', children })}
					{pane({
						id: 'inspection',
						role: 'inspector',
						title: 'Inspection',
						children: 'inspection',
					})}
				</WorkbenchPaneLayout>
			</WorkbenchViewProvider>
		</RemotePaneLayoutStateProvider>
	)
}

function descriptors(): WorkbenchPaneDescriptor[] {
	return [
		{ id: 'scenario', role: 'navigation', title: 'Scenario', content: null },
		{ id: 'main', role: 'primary', title: 'Main', content: null },
		{ id: 'inspection', role: 'inspector', title: 'Inspection', content: null },
	]
}

function stateService() {
	const values = new Map<string, unknown>()
	const listeners = new Map<string, Set<() => void>>()
	const write = vi.fn((scope: string, value: unknown) => {
		values.set(scope, value)
		for (const listener of listeners.get(scope) ?? []) listener()
	})
	return {
		write,
		api: {
			read: (scope: string) => values.get(scope),
			write,
			subscribe(scope: string, listener: () => void) {
				const bucket = listeners.get(scope) ?? new Set()
				bucket.add(listener)
				listeners.set(scope, bucket)
				return () => bucket.delete(listener)
			},
		} satisfies WorkbenchViewState,
	}
}
