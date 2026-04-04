// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import type React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	PluginOrganizer,
	type GroupConfig,
	type PluginStatuses,
} from '../../../components/src/app/plugins/catalog/organizer/PluginOrganizer'

type MountedApp = {
	container: HTMLDivElement
	root: Root
}

const mountedApps: MountedApp[] = []

class ResizeObserverMock {
	disconnect() {}
	observe() {}
	unobserve() {}
}

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	if (typeof globalThis.ResizeObserver === 'undefined') {
		globalThis.ResizeObserver = ResizeObserverMock as any
	}
	const storage = (() => {
		const values = new Map<string, string>()
		return {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value)
			},
			removeItem: (key: string) => {
				values.delete(key)
			},
			clear: () => {
				values.clear()
			},
			key: (index: number) => Array.from(values.keys())[index] ?? null,
			get length() {
				return values.size
			},
		}
	})()
	Object.defineProperty(window, 'localStorage', {
		value: storage,
		configurable: true,
	})
	if (typeof window.matchMedia !== 'function') {
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})) as typeof window.matchMedia
	}
	if (typeof Element.prototype.scrollTo !== 'function') {
		Element.prototype.scrollTo = function scrollTo(
			options?: ScrollToOptions | number,
			y?: number,
		): void {
			if (typeof options === 'number') {
				;(this as HTMLElement).scrollTop = y ?? 0
				return
			}
			;(this as HTMLElement).scrollTop = options?.top ?? 0
		}
	}
	if (typeof Element.prototype.scrollIntoView !== 'function') {
		Element.prototype.scrollIntoView = () => {}
	}
})

afterEach(async () => {
	while (mountedApps.length > 0) {
		const mounted = mountedApps.pop()
		if (!mounted) continue
		await act(async () => {
			mounted.root.unmount()
		})
		mounted.container.remove()
	}
})

function buildStatuses(count: number): PluginStatuses {
	const statuses: PluginStatuses = {}
	for (let index = 0; index < count; index += 1) {
		const pluginId = `plugin-${String(index).padStart(3, '0')}`
		statuses[pluginId] = {
			name: `Plugin ${String(index).padStart(3, '0')}`,
			isRunning: index % 3 === 0,
			isEnabled: index % 7 !== 0,
			sourceKind: index % 5 === 0 ? 'hmr' : 'package',
			moduleId: index % 5 === 0 ? `/workspace/demo-${Math.floor(index / 5)}/index.ts` : undefined,
			tag: index % 2 === 0 ? 'stable' : 'beta',
			version: `1.0.${index}`,
		} as any
	}
	return statuses
}

async function renderOrganizer(props: {
	statuses: PluginStatuses
	initialGroups?: GroupConfig[]
	filterQuery?: string
	activeId?: string | null
	onSelectedIdsChange?: (ids: string[]) => void
	clicked?: Array<{ to: string; mode?: string }>
}) {
	const container = document.createElement('div')
	container.style.height = '480px'
	container.style.width = '360px'
	document.body.appendChild(container)
	const root = createRoot(container)
	mountedApps.push({ container, root })

	const LinkComponent = ({
		to,
		children,
		onClick,
		workbenchMode: _workbenchMode,
		...rest
	}: {
		to: string
		children: React.ReactNode
		workbenchMode?: string
	} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>) => (
		<a
			href={to}
			{...rest}
			onClick={(event) => {
				event.preventDefault()
				props.clicked?.push({ to, mode: _workbenchMode })
				onClick?.(event)
			}}
		>
			{children}
		</a>
	)

	await act(async () => {
		root.render(
			<MantineProvider>
				<div style={{ height: '480px' }}>
					<PluginOrganizer
						statuses={props.statuses}
						initialGroups={props.initialGroups ?? []}
						onGroupsChange={() => {}}
						filterQuery={props.filterQuery}
						activeId={props.activeId}
						onSelectedIdsChange={props.onSelectedIdsChange}
						LinkComponent={LinkComponent}
					/>
				</div>
			</MantineProvider>,
		)
	})

	await act(async () => {
		await Promise.resolve()
	})

	return container
}

describe('PluginOrganizer virtualization', () => {
	it('renders filtered results as a flat virtualized list and keeps row actions working', async () => {
		const statuses = buildStatuses(420)
		const selectedChanges = vi.fn()
		const clicked: Array<{ to: string; mode?: string }> = []
		const container = await renderOrganizer({
			statuses,
			initialGroups: [
				{
					groupId: 'group-a',
					name: 'Alpha',
					pluginIds: ['plugin-010', 'plugin-011', 'plugin-012'],
				},
			],
			filterQuery: 'plugin',
			onSelectedIdsChange: selectedChanges,
			clicked,
		})

		const rows = container.querySelectorAll('[data-plugin-row="true"]')
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(420)
		expect(container.textContent).toContain('平铺结果')
		expect(container.querySelector('.plx-pluginCatalog__subgroupHeader')).toBeNull()

		const selector = container.querySelector('[data-row-selector="true"]')
		expect(selector).not.toBeNull()
		await act(async () => {
			selector?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		})
		expect(selectedChanges).toHaveBeenLastCalledWith(['plugin-000'])

		const firstRow = container.querySelector('[data-plugin-row="true"]')
		expect(firstRow).not.toBeNull()
		await act(async () => {
			firstRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
		})
		expect(clicked).toContainEqual({ to: '/plugins/plugin-000', mode: 'replace-active' })

		const organizer = container.querySelector('[aria-label="插件列表与分组"]') as HTMLElement | null
		expect(organizer).not.toBeNull()
		organizer?.focus()

		await act(async () => {
			organizer?.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
				}),
			)
		})
		expect(clicked).toContainEqual({ to: '/plugins/plugin-000', mode: 'replace-active' })

		await act(async () => {
			organizer?.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					ctrlKey: true,
					bubbles: true,
				}),
			)
		})
		expect(clicked).toContainEqual({ to: '/plugins/plugin-000', mode: 'open-tab' })
	})

	it('keeps large ungrouped browse mode unflattened when no filtering is active', async () => {
		const statuses = buildStatuses(180)
		const container = await renderOrganizer({
			statuses,
		})

		const rows = container.querySelectorAll('[data-plugin-row="true"]')
		expect(rows.length).toBe(180)
		expect(container.textContent).not.toContain('平铺结果')
		expect(container.querySelector('.plx-pluginCatalog__subgroupHeader')).not.toBeNull()
	})

	it('preserves grouped browse mode when no filtering is active', async () => {
		const statuses = buildStatuses(6)
		const container = await renderOrganizer({
			statuses,
			initialGroups: [
				{ groupId: 'group-a', name: 'Alpha', pluginIds: ['plugin-001', 'plugin-002'] },
			],
		})

		expect(container.textContent).toContain('未分组')
		expect(container.textContent).toContain('我的分组')
		expect(container.textContent).toContain('Alpha')
		expect(container.querySelector('.plx-pluginCatalog__subgroupHeader')).not.toBeNull()
		expect(container.querySelectorAll('[data-plugin-row="true"]')).toHaveLength(6)
	})
})
