// @vitest-environment jsdom

import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { RpcStub } from 'capnweb'
import type {
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchSessionApi,
} from '@pluxel/workbench/client'
import {
	createMemoryHistory,
	RouterProvider,
	useRouter,
	type AnyRouter,
} from '@tanstack/react-router'
import { Workbench } from '@worksplit/react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAppRouter } from '../src/app/router'
import { WorkspaceSession } from '../src/app/workbench/session'
import { buildWorkbenchHref } from '../src/workbench/paths'
import { WorkbenchRuntimeProvider, WorkbenchSessionProvider } from '../src/workbench/runtime'
import { prepareNativeWorkbenchDom, WorkspaceProviders } from './helpers/native-workbench'

// Authentication is supplied at the transport boundary; the real directory,
// content routes and per-document memory Router decide which page is shown.
const observed = vi.hoisted(() => ({ routers: [] as AnyRouter[] }))
vi.mock('../src/app/router/workbench/WorkbenchDeclaredRouteScreen', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('../src/app/router/workbench/WorkbenchDeclaredRouteScreen')
		>()
	return {
		WorkbenchDeclaredRouteScreen: (props: { pathname: string }) => {
			const router = useRouter()
			if (!observed.routers.includes(router)) observed.routers.push(router)
			return <actual.WorkbenchDeclaredRouteScreen {...props} />
		},
	}
})
vi.mock('../src/app/log_viewer/LiveLog', () => ({ LiveLog: () => <p>Runtime logs</p> }))
vi.mock('../src/app/workbench/WorkspaceNavigation', () => ({ WorkspaceNavigation: () => null }))

const roots: Root[] = []
const workspaces: WorkspaceSession[] = []
beforeEach(prepareNativeWorkbenchDom)
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
		for (const workspace of workspaces.splice(0)) await workspace.dispose()
	})
	document.body.replaceChildren()
	window.localStorage.clear()
	observed.routers.length = 0
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
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
	options: { basepath?: string; pending?: Promise<void>; standalone?: boolean } = {},
) {
	const basepath = options.basepath ?? '/'
	const workspace = new WorkspaceSession({ basepath })
	workspaces.push(workspace)
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
	const session = { layoutDto: layout } as unknown as RpcStub<WorkbenchSessionApi>
	const standalone = options.standalone
		? createAppRouter({
				history: createMemoryHistory({
					initialEntries: [`${basepath === '/' ? '' : basepath}${path}`],
				}),
				uiBasePath: basepath,
			})
		: undefined
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container)
	roots.push(root)
	await act(async () => {
		root.render(
			<WorkspaceProviders session={workspace}>
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
						{standalone ? (
							<RouterProvider router={standalone} />
						) : (
							<Workbench workbench={workspace.workbench} />
						)}
					</WorkbenchRuntimeProvider>
				</WorkbenchSessionProvider>
			</WorkspaceProviders>,
		)
		if (standalone) await standalone.load()
		else await workspace.start(`${basepath === '/' ? '' : basepath}${path}`, false)
	})
	const router = standalone ?? observed.routers.at(-1)!
	const active = () =>
		container.querySelector(
			`[data-worksplit-content="${workspace.workbench.getActiveDocument()?.id}"]`,
		)!
	return { workspace, router, container, layout, active }
}

it.each(['/', '/__pluxel/workbench'])(
	'matches declared nested paths through each document Router under %s and keeps the native workspace on builtin navigation',
	async (basepath) => {
		const { workspace, router, container, active } = await mount(
			'/accounts/a%20b/history',
			[entry('Accounts', '/accounts/:id/history')],
			{ basepath },
		)
		expect(router.state.matches.at(-1)?.routeId).toBe('/_workbench/$')
		expect(router.state.matches.at(-1)?.params).toMatchObject({ _splat: 'accounts/a b/history' })
		expect(active().textContent).toContain('Selected renderer: Accounts')
		const native = container.querySelector('.worksplit-workbench')
		await act(async () => {
			const result = await workspace.workbench.open({ to: '/logs' })
			expect(result.status).toBe('committed')
		})
		expect(active().textContent).toContain('Runtime logs')
		expect(container.querySelector('.worksplit-workbench')).toBe(native)
		await act(async () => {
			await workspace.workbench.open({ to: '/accounts/other/history' })
		})
		expect(active().textContent).toContain('Selected renderer: Accounts')
		expect(container.querySelector('.worksplit-workbench')).toBe(native)
	},
)

it('renders a standalone declared route through the complete directory without a native Shell', async () => {
	const { container, router } = await mount(
		'/preview/a',
		[entry('Preview', '/preview/:id', 'standalone')],
		{ standalone: true },
	)
	expect(router.state.matches.at(-1)?.routeId).toBe('/_workbench/$')
	expect(container.textContent).toContain('Selected renderer: Preview')
	expect(container.querySelector('.worksplit-workbench')).toBeNull()
})

it('shows short-path conflicts and uses a concrete canonical fallback for its exact owner', async () => {
	const entries = [entry('Accounts', '/accounts/:id'), entry('Billing', '/accounts/:accountId')]
	const { workspace, active } = await mount('/accounts/42', entries)
	expect(active().textContent).toContain('这个路径有多个注册来源')
	expect([...active().querySelectorAll('a')].some((link) => /:id|:accountId/.test(link.href))).toBe(
		false,
	)
	const canonical = buildWorkbenchHref(entries[1]!.target.node, '/accounts/42', 'shell')
	const link = [...active().querySelectorAll<HTMLAnchorElement>('a')].find(
		(item) => item.getAttribute('href') === canonical,
	)
	expect(link).toBeDefined()
	const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
	await act(async () => {
		link!.dispatchEvent(click)
		await vi.waitFor(() => expect(workspace.workbench.getActiveDocument()?.href).toBe(canonical))
	})
	expect(click.defaultPrevented).toBe(true)
	expect(active().textContent).toContain('Selected renderer: Billing')
	expect(active().textContent).not.toContain('Selected renderer: Accounts')
})

it('waits for the full directory before deciding a short path is missing', async () => {
	let release!: () => void
	const pending = new Promise<void>((resolve) => {
		release = resolve
	})
	const { active } = await mount('/accounts/42', [entry('Accounts', '/accounts/:id')], { pending })
	expect(active().textContent).toContain('管理界面加载中')
	expect(active().textContent).not.toContain('页面不存在')
	await act(async () => {
		release()
		await pending
	})
	expect(active().textContent).toContain('Selected renderer: Accounts')
	expect(active().textContent).not.toContain('页面不存在')
})
