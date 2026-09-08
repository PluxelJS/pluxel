// @vitest-environment jsdom

import { formatPluginNodeRoute } from '@pluxel/core'
import { MantineProvider } from '@mantine/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkbenchDocumentRenderer } from '../src/app/workbench/shell/WorkbenchDocumentRenderer'
import { RightPane } from '../src/app/plugins/detail/RightPane'
import { WorkspaceControllerProvider } from '../src/app/workbench/context'
import { WorkspaceController } from '../src/app/workbench/store'
import { createPersistedWorkbenchState, WORKBENCH_STORAGE_KEY } from '../src/app/workbench/state'
import type { WorkbenchLayoutEntry } from '@pluxel/runtime/workbench/client'

const state = vi.hoisted(() => ({
	pathname: '',
	pluginRoute: 'v1/package/FirstPlugin/@fixture/first',
	crashedRoute: '',
	entries: [] as WorkbenchLayoutEntry[],
}))
const mounted: Root[] = []

vi.mock('../src/app/plugins/detail/PluginScreen', () => ({
	PluginScreen: ({ pluginRoute }: { pluginRoute: string }) => {
		if (pluginRoute === state.crashedRoute) throw new Error('fixture plugin page failed')
		return <input aria-label="插件表单" defaultValue={pluginRoute} />
	},
}))
vi.mock('../src/app/router/screens/RouteErrorScreen', () => ({
	RouteErrorScreen: ({ onRetry }: { onRetry?: () => void }) => (
		<div role="alert">
			页面错误
			<button type="button" onClick={onRetry}>
				重试
			</button>
		</div>
	),
}))
vi.mock('../src/app/log_viewer/LiveLog', () => ({ LiveLog: () => null }))
vi.mock('../src/app/plugins/catalog/PluginCatalog', () => ({ PluginCatalog: () => null }))
vi.mock('../src/app/plugin-graph/LazyPluginGraphScreen', () => ({
	LazyPluginGraphScreen: () => null,
}))
vi.mock('../src/app/router/screens/NotFoundScreen', () => ({ NotFoundScreen: () => null }))
vi.mock('../src/app/router/screens/HomeScreen', () => ({ HomeScreen: () => null }))
vi.mock('../src/app/router/workbench/WorkbenchRouteScreen', () => ({
	WorkbenchRouteScreen: () => null,
}))
vi.mock('../src/app/security/SecurityAuditScreen', () => ({ SecurityAuditScreen: () => null }))
vi.mock('../src/app/security/SecurityScreen', () => ({ SecurityScreen: () => null }))
vi.mock('../src/app/workbench/context', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/app/workbench/context')>()),
	useWorkbenchDocumentPathname: () => state.pathname,
}))
vi.mock('../src/workbench/runtime', () => ({
	useWorkbenchTabs: () => ({
		nodes: state.entries.map((entry) => <p key={entry.descriptor.key}>Version Content</p>),
		entries: state.entries,
	}),
	useResolvedWorkbenchRoute: () => ({ route: null, snapshot: null }),
}))
vi.mock('../src/app/plugins/detail/context', () => ({
	usePluginMeta: () => ({
		pluginRoute: state.pluginRoute,
		pluginLabel: 'FirstPlugin',
		status: {
			execution: {
				kind: 'static-bundle',
				artifact: { kind: 'application-bundle' },
				update: { kind: 'deployment' },
			},
		},
	}),
}))
vi.mock('../src/app/plugins/detail/controls/ActionBar', () => ({ ActionBar: () => null }))
vi.mock('../src/app/plugins/detail/cards/LogLevelsCard', () => ({
	LogLevelsCard: () => <p>日志级别</p>,
}))
vi.mock('../src/app/plugins/config/ConfigForm', () => ({ ConfigForm: () => null }))
vi.mock('../src/app/router/workbench/WorkbenchRouteRenderer', () => ({
	WorkbenchRouteRenderer: () => <p>插件页面</p>,
}))
vi.mock('../src/components', () => ({
	EmptyState: () => <input aria-label="配置状态" />,
	ErrorState: () => null,
}))

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
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	state.crashedRoute = ''
	state.entries = []
	window.localStorage.clear()
})

function mountRoot() {
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container, { onCaughtError: () => undefined })
	mounted.push(root)
	return { container, root }
}

describe('plugin route-local state', () => {
	it('isolates a failed document and retries or navigates without disturbing another editor', async () => {
		const { container, root } = mountRoot()
		const firstPath = `/plugins/${state.pluginRoute}`
		const secondRoute = 'v1/package/SecondPlugin/@fixture/second'
		const render = async (secondPath: string) => {
			await act(async () => {
				root.render(
					<div data-shell>
						<WorkbenchDocumentRenderer pathname={firstPath} />
						<WorkbenchDocumentRenderer pathname={secondPath} />
					</div>,
				)
			})
		}
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		try {
			await render(`/plugins/${secondRoute}`)
			const shell = container.querySelector('[data-shell]')
			const first = container.querySelector('input')!
			first.value = 'unsaved healthy editor'
			state.crashedRoute = secondRoute
			await render(`/plugins/${secondRoute}`)
			expect(container.querySelector('[role="alert"]')).not.toBeNull()
			expect(container.querySelector('[data-shell]')).toBe(shell)
			expect(container.querySelector('input')).toBe(first)
			expect(first.value).toBe('unsaved healthy editor')
			state.crashedRoute = ''
			await act(async () => {
				container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
			})
			expect(container.querySelector('[role="alert"]')).toBeNull()
			expect(container.querySelectorAll('input')).toHaveLength(2)
			expect(container.querySelector('input')).toBe(first)
			state.crashedRoute = secondRoute
			await render(`/plugins/${secondRoute}`)
			expect(container.querySelector('[role="alert"]')).not.toBeNull()
			await render('/logs')
			expect(container.querySelector('[role="alert"]')).toBeNull()
			expect(container.querySelector('input')).toBe(first)
			expect(first.value).toBe('unsaved healthy editor')
		} finally {
			report.mockRestore()
		}
	})

	it('retains the same node across child routes but isolates different plugins and forks', async () => {
		const { container, root } = mountRoot()
		const render = async (path: string) => {
			await act(async () => {
				root.render(<WorkbenchDocumentRenderer pathname={path} />)
			})
		}
		const base = `/plugins/${state.pluginRoute}`
		await render(base)
		const first = container.querySelector('input')!
		first.value = 'unsaved first plugin state'
		for (const path of [`${base}/orders`, `${base}/config`, base]) {
			await render(path)
			expect(container.querySelector('input')).toBe(first)
			expect(first.value).toBe('unsaved first plugin state')
		}
		const forkRoute = formatPluginNodeRoute({
			definition: {
				entry: { kind: 'package-root', packageName: '@fixture/first' },
				exportName: 'FirstPlugin',
			},
			variant: 'fork',
			forkId: 'secondary',
		})
		await render(`/plugins/${forkRoute}`)
		const fork = container.querySelector('input')!
		expect(fork).not.toBe(first)
		expect(fork.value).toBe(forkRoute)
		await render('/plugins/v1/package/SecondPlugin/@fixture/second')
		expect(container.querySelector('input')).not.toBe(fork)
		expect(container.querySelector('input')?.value).toBe('v1/package/SecondPlugin/@fixture/second')
	})

	it('returns to configuration from a plugin page without discarding local config state', async () => {
		const { container, root } = mountRoot()
		const workspace = new WorkspaceController(`/plugins/${state.pluginRoute}`)
		const config = { loading: false, refetch: vi.fn() }
		const render = async (restPath: string) => {
			state.pathname = `/plugins/${state.pluginRoute}${restPath}`
			await act(async () => {
				root.render(
					<MantineProvider env="test">
						<WorkspaceControllerProvider controller={workspace}>
							<RightPane config={config} showLevelsTab />
						</WorkspaceControllerProvider>
					</MantineProvider>,
				)
			})
		}
		const selectedTab = () =>
			container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
		await render('/config')
		const input = container.querySelector<HTMLInputElement>('[aria-label="配置状态"]')!
		input.value = 'unsaved config state'
		await render('/orders')
		expect(selectedTab()).toBe('页面')
		await render('/config')
		expect(selectedTab()).toBe('配置')
		expect(container.querySelector('[aria-label="配置状态"]')).toBe(input)
		expect(input.value).toBe('unsaved config state')
		const logging = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
			(tab) => tab.textContent === '级别',
		)!
		await act(async () => {
			logging.click()
		})
		await render('')
		expect(selectedTab()).toBe('级别')
		await render('/config')
		expect(selectedTab()).toBe('配置')
		expect(container.querySelector('[aria-label="配置状态"]')).toBe(input)
	})

	it('restores the selected Workbench tab after document replacement and waits for the new layout', async () => {
		const { container, root } = mountRoot()
		state.pathname = `/plugins/${state.pluginRoute}`
		const entries = [
			{
				placement: { kind: 'tab', label: 'Version', order: 0 },
				descriptor: { key: 'page' },
				target: { displayName: 'FirstPlugin' },
			},
		] as unknown as WorkbenchLayoutEntry[]
		state.entries = entries
		const first = new WorkspaceController(state.pathname)
		const render = async (workspace: WorkspaceController) => {
			await act(async () => {
				root.render(
					<MantineProvider env="test">
						<WorkspaceControllerProvider controller={workspace}>
							<RightPane config={{ loading: false, refetch: vi.fn() }} />
						</WorkspaceControllerProvider>
					</MantineProvider>,
				)
			})
		}
		const selected = () =>
			container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
		await render(first)
		await act(async () => {
			Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
				.find((tab) => tab.textContent === 'Version')!
				.click()
		})
		expect(selected()).toBe('Version')
		window.localStorage.setItem(
			WORKBENCH_STORAGE_KEY,
			JSON.stringify(createPersistedWorkbenchState(first.state.uiState)),
		)
		await act(async () => {
			root.render(null)
		})
		state.entries = []
		const restored = new WorkspaceController(state.pathname)
		await render(restored)
		expect(selected()).toBe('配置')
		state.entries = entries
		await render(restored)
		expect(selected()).toBe('Version')
	})

	it('lets a manual Workbench tab choice override the current route until the route changes', async () => {
		const { container, root } = mountRoot()
		state.pathname = `/plugins/${state.pluginRoute}/config`
		state.entries = [
			{
				placement: { kind: 'tab', label: 'Version', order: 0 },
				descriptor: { key: 'page' },
				target: { displayName: 'FirstPlugin' },
			},
		] as unknown as WorkbenchLayoutEntry[]
		const workspace = new WorkspaceController(state.pathname)
		const render = async () => {
			await act(async () => {
				root.render(
					<MantineProvider env="test">
						<WorkspaceControllerProvider controller={workspace}>
							<RightPane config={{ loading: false, refetch: vi.fn() }} />
						</WorkspaceControllerProvider>
					</MantineProvider>,
				)
			})
		}
		const selected = () =>
			container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
		const chooseVersion = async () => {
			await act(async () => {
				Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
					.find((tab) => tab.textContent === 'Version')!
					.click()
			})
		}
		await render()
		expect(selected()).toBe('配置')
		await chooseVersion()
		expect(selected()).toBe('Version')
		await act(async () => {
			workspace.toggleNavigationCollapsed()
		})
		state.entries = [...state.entries]
		await render()
		expect(selected()).toBe('Version')
		state.pathname = `/plugins/${state.pluginRoute}/orders`
		await render()
		expect(selected()).toBe('页面')
		await chooseVersion()
		await render()
		expect(selected()).toBe('Version')
		state.pathname = `/plugins/${state.pluginRoute}/config`
		await render()
		expect(selected()).toBe('配置')
	})
})
