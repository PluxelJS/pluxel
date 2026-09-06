// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { act, type React } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
	PluginOrganizer,
	type GroupConfig,
	type PluginStatuses,
} from '../../../workbench-app/src/app/plugins/catalog/organizer/PluginOrganizer'

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
		const exportName = `Plugin${String(index).padStart(3, '0')}`
		const packageName = `@fixture/${pluginId}`
		statuses[pluginId] = {
			id: pluginId,
			address: {
				definition: {
					entry: { kind: 'package-root', packageName },
					exportName,
				},
				variant: 'default',
			},
			reference: `package:${packageName}::${exportName}`,
			name: `Plugin ${String(index).padStart(3, '0')}`,
			definitionLabel: packageName,
			packageName,
			exportName,
			executionLabel: index % 5 === 0 ? '源码 HMR' : '静态构建',
			executionTone: index % 5 === 0 ? 'blue' : 'gray',
			executionDescription:
				index % 5 === 0 ? '动态插件入口 · 源码模块；源码依赖图 HMR' : '应用静态构建',
			executionSearchTerms:
				index % 5 === 0 ? ['dynamic-entry', 'source-graph'] : ['static-bundle'],
			availability: index % 7 === 0 ? 'unavailable' : 'available',
			autoStart: index % 2 === 0,
			desiredState: index % 3 === 0 ? 'running' : 'stopped',
			lifecycleState: index % 3 === 0 ? 'running' : 'stopped',
		}
	}
	return statuses
}

async function renderOrganizer(props: {
	statuses: PluginStatuses
	initialGroups?: GroupConfig[]
	filterQuery?: string
	activeId?: string | null
	onSelectedIdsChange?: (ids: string[]) => void
	clicked?: Array<{ to: string }>
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
		...rest
	}: {
		to: string
		children: React.ReactNode
	} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>) => (
		<a
			href={to}
			{...rest}
			onClick={(event) => {
				event.preventDefault()
				props.clicked?.push({ to })
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
	it('keeps ungrouped browse mode unflattened when no filtering is active', async () => {
		const statuses = buildStatuses(12)
		const container = await renderOrganizer({
			statuses,
		})

		const rows = container.querySelectorAll('[data-plugin-row="true"]')
		expect(rows.length).toBe(12)
		expect(container.textContent).not.toContain('平铺结果')
	}, 30_000)

	it('preserves grouped browse mode when no filtering is active', async () => {
		const statuses = buildStatuses(6)
		const container = await renderOrganizer({
			statuses,
			initialGroups: [
				{ groupId: 'group-a', name: 'Alpha', pluginIds: ['plugin-001', 'plugin-002'] },
			],
		})

		expect(container.textContent).toContain('未分组')
		expect(container.textContent).toContain('插件分类')
		expect(container.textContent).toContain('Alpha')
		expect(container.textContent).not.toContain('新建分组')
		expect(container.querySelector('[role="group"][aria-label="分组 Alpha"]')).not.toBeNull()
		expect(container.querySelectorAll('[data-plugin-row="true"]')).toHaveLength(6)
	})
})
