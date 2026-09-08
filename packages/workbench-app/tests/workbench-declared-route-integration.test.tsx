// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { RpcStub } from '@pluxel/runtime/capnweb'
import type {
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchSessionApi,
} from '@pluxel/runtime/workbench/client'
import { createMemoryHistory, Outlet, RouterProvider } from '@tanstack/react-router'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createAppRouter } from '../src/app/router'
import { WorkspaceControllerProvider } from '../src/app/workbench/context'
import { WorkspaceController } from '../src/app/workbench/store'
import { buildWorkbenchHref } from '../src/workbench/paths'
import { WorkbenchRuntimeProvider, WorkbenchSessionProvider } from '../src/workbench/runtime'

// Supply the already-authenticated session at the transport boundary. Route
// matching, layout validation, directory compilation, Shell and document routing
// all use their production implementations.
vi.mock('../src/app/frames/AppProviders', () => ({ AppProviders: () => <Outlet /> }))
vi.mock('../src/app/workbench/shell/WorkbenchUpdateStatus', () => ({
	WorkbenchUpdateStatus: () => null,
}))
vi.mock('../src/app/log_viewer/LiveLog', () => ({ LiveLog: () => <p>Runtime logs</p> }))
vi.mock('../src/app/workbench/shell/WorkbenchShellViews', () => ({
	ActivityRail: () => null,
	PluginNavigationRail: () => null,
	RouteGroupRail: () => null,
	PluginQuickOpenAction: () => null,
	WorkbenchTopbarTools: () => null,
	WorkbenchHotkeys: () => null,
}))
vi.mock('../src/app/workbench/shell/WorkspaceEditorGrid', async () => {
	const { WorkbenchDocumentRenderer } =
		await import('../src/app/workbench/shell/WorkbenchDocumentRenderer')
	return {
		WorkspaceEditorGrid: ({ pathname }: { pathname: string }) => (
			<WorkbenchDocumentRenderer pathname={pathname} />
		),
	}
})

const roots: ReturnType<typeof createRoot>[] = []
beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	window.scrollTo = vi.fn()
	window.matchMedia = vi.fn((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}))
	globalThis.ResizeObserver = class {
		constructor(private readonly callback: ResizeObserverCallback) {}
		observe(target: Element) {
			this.callback(
				[{ target, contentRect: { width: 1440, height: 900 } } as ResizeObserverEntry],
				this,
			)
		}
		unobserve() {}
		disconnect() {}
	}
})
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
})

function entry(
	name: string,
	path: string,
	frame: 'shell' | 'standalone' = 'shell',
): WorkbenchLayoutEntry {
	const node: PluginNodeAddress = {
		definition: {
			entry: { kind: 'package-root', packageName: `@test/${name.toLowerCase()}` },
			exportName: name,
		},
		variant: 'default',
	}
	return {
		descriptor: { kind: 'view', owner: node.definition, key: name.toLowerCase() },
		target: { node, displayName: name },
		renderer: node,
		definitionRevisions: { target: 1, renderer: 1 },
		placement: { kind: 'route', path, frame, title: `${name} page`, order: 0 },
		federatedViewUnavailable: { reason: 'failed', message: `Selected renderer: ${name}` },
	}
}

async function mount(
	path: string,
	entries: WorkbenchLayoutEntry[],
	options: { basepath?: string; pending?: Promise<void> } = {},
) {
	const basepath = options.basepath ?? '/'
	const router = createAppRouter({
		history: createMemoryHistory({
			initialEntries: [`${basepath === '/' ? '' : basepath}${path}`],
		}),
		uiBasePath: basepath,
	})
	const layout = vi.fn(
		async ({ target }: { target: PluginNodeAddress | null }): Promise<WorkbenchLayout> => {
			await options.pending
			return {
				profile: 1,
				revision: 1,
				target: target
					? entries.find(
							(item) => pluginNodeIndexKey(item.target.node) === pluginNodeIndexKey(target),
						)!.target
					: null,
				entries: target
					? entries.filter(
							(item) => pluginNodeIndexKey(item.target.node) === pluginNodeIndexKey(target),
						)
					: entries,
			}
		},
	)
	const session = { layout } as unknown as RpcStub<WorkbenchSessionApi>
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				<WorkbenchSessionProvider session={session}>
					<WorkbenchRuntimeProvider
						host={{
							locale: 'zh-Hans',
							colorScheme: 'light',
							notify: vi.fn(),
							confirm: async () => true,
							runningPluginsReady: true,
							runningPluginKeys: new Set(
								entries.map((item) => pluginNodeIndexKey(item.target.node)),
							),
						}}
					>
						<WorkspaceControllerProvider controller={new WorkspaceController(path)}>
							<RouterProvider router={router} />
						</WorkspaceControllerProvider>
					</WorkbenchRuntimeProvider>
				</WorkbenchSessionProvider>
			</MantineProvider>,
		)
		await router.load()
	})
	return { router, container, layout }
}

it.each(['/', '/__pluxel/workbench'])(
	'matches declared nested paths through the real route tree under %s and keeps Shell on builtin navigation',
	async (basepath) => {
		const { router, container } = await mount(
			'/accounts/a%20b/history',
			[entry('Accounts', '/accounts/:id/history')],
			{ basepath },
		)
		expect(router.state.matches.at(-1)?.routeId).toBe('/_workbench/$')
		expect(router.state.matches.at(-1)?.params).toMatchObject({ _splat: 'accounts/a b/history' })
		expect(container.textContent).toContain('Selected renderer: Accounts')
		const shell = container.querySelector('.plx-workbench')
		expect(shell).not.toBeNull()
		await act(async () => {
			await router.navigate({ to: '/logs' })
		})
		expect(container.textContent).toContain('Runtime logs')
		expect(container.querySelector('.plx-workbench')).toBe(shell)
		await act(async () => {
			await router.navigate({ to: '/accounts/other/history' })
		})
		expect(container.textContent).toContain('Selected renderer: Accounts')
		expect(container.querySelector('.plx-workbench')).toBe(shell)
	},
)

it('selects standalone presentation from the complete route directory', async () => {
	const { container, router } = await mount('/preview/a', [
		entry('Preview', '/preview/:id', 'standalone'),
	])
	expect(router.state.matches.at(-1)?.routeId).toBe('/_workbench/$')
	expect(container.textContent).toContain('Selected renderer: Preview')
	expect(container.querySelector('.plx-workbench')).toBeNull()
})

it('shows conflicts in the header and follows a concrete canonical fallback to its exact owner', async () => {
	const entries = [entry('Accounts', '/accounts/:id'), entry('Billing', '/accounts/:accountId')]
	const { container, router } = await mount('/accounts/42', entries)
	expect(container.textContent).toContain('这个路径有多个注册来源')
	expect(container.querySelector('header')?.textContent).toContain('路由冲突 2')
	const headerNotice = [...container.querySelectorAll<HTMLButtonElement>('header button')].find(
		(button) => button.textContent === '路由冲突 2',
	)!
	await act(async () => headerNotice.click())
	expect(document.body.textContent).toContain('以下页面使用完整路径')
	expect(document.body.textContent).toContain('修改插件声明的路径即可消除冲突')
	expect(
		[...document.body.querySelectorAll('a')].some((link) => /:id|:accountId/.test(link.href)),
	).toBe(false)
	const canonical = buildWorkbenchHref(entries[1]!.target.node, '/accounts/42', 'shell')
	const link = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(
		(item) => item.getAttribute('href') === canonical,
	)
	expect(link).toBeDefined()
	const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
	await act(async () => {
		link!.dispatchEvent(click)
		await vi.waitFor(() => expect(router.state.location.pathname).toBe(canonical))
	})
	expect(click.defaultPrevented).toBe(true)
	expect(container.textContent).toContain('Selected renderer: Billing')
	expect(container.textContent).not.toContain('Selected renderer: Accounts')
})

it('waits for the full directory before deciding that a short path is missing', async () => {
	let release!: () => void
	const pending = new Promise<void>((resolve) => {
		release = resolve
	})
	const { container } = await mount('/accounts/42', [entry('Accounts', '/accounts/:id')], {
		pending,
	})
	expect(container.textContent).toContain('管理界面加载中')
	expect(container.textContent).not.toContain('页面不存在')
	await act(async () => {
		release()
		await pending
	})
	expect(container.textContent).toContain('Selected renderer: Accounts')
	expect(container.textContent).not.toContain('页面不存在')
})
