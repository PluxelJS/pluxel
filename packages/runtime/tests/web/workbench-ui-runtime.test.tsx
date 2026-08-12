// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { workbenchContract } from '../../src/workbench/contracts'
import {
	createWorkbenchUi,
	useWorkbenchHost,
	WorkbenchViewProvider,
} from '../../src/workbench/ui-runtime'
import {
	WorkbenchPane,
	WorkbenchPaneLayout,
	type WorkbenchPaneProps,
	type WorkbenchPaneLayoutRendererProps,
} from '../../src/workbench/ui-pane'

const contract = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<{ ping(): string }>(),
	},
	views: {},
})
const ui = createWorkbenchUi(contract)
const mounted: Array<ReturnType<typeof createRoot>> = []
const pane = (props: WorkbenchPaneProps) => <WorkbenchPane {...props} />

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
})

describe('Workbench UI resource facade', () => {
	it('normalizes a valid pane declaration for the host renderer', async () => {
		let rendered: WorkbenchPaneLayoutRendererProps | undefined
		const container = document.createElement('div')
		const root = createRoot(container)
		mounted.push(root)
		const Renderer = (props: WorkbenchPaneLayoutRendererProps) => {
			rendered = props
			return null
		}

		await act(async () => {
			root.render(
				<WorkbenchViewProvider
					item={{ ownerPluginId: 'Owner', targetPluginId: 'Target' } as never}
					environment={{ locale: { locale: 'zh-CN', subscribe: () => () => {} } } as never}
					paneLayoutRenderer={Renderer}
				>
					<WorkbenchPaneLayout id="access">
						{pane({
							id: 'nav',
							role: 'navigation',
							title: 'Navigation',
							children: <span>nav child</span>,
						})}
						{pane({
							id: 'main',
							role: 'primary',
							title: 'Editor',
							children: <span>main child</span>,
						})}
					</WorkbenchPaneLayout>
				</WorkbenchViewProvider>,
			)
		})

		expect(rendered).toMatchObject({ id: 'access', label: 'Workbench panes' })
		expect(rendered?.panes.map((item) => [item.id, item.role])).toEqual([
			['nav', 'navigation'],
			['main', 'primary'],
		])
	})

	it.each([
		['non-pane child', <div key="non-pane" />],
		[
			'duplicate ids',
			<>
				{pane({ id: 'same', role: 'navigation', title: 'Navigation', children: 'a' })}
				{pane({ id: 'same', role: 'primary', title: 'Editor', children: 'b' })}
			</>,
		],
		[
			'duplicate roles',
			<>
				{pane({ id: 'a', role: 'primary', title: 'A', children: 'a' })}
				{pane({ id: 'b', role: 'primary', title: 'B', children: 'b' })}
			</>,
		],
		[
			'hideable primary',
			pane({ id: 'main', role: 'primary', title: 'Editor', defaultVisible: false, children: 'a' }),
		],
		[
			'too many panes',
			<>
				{pane({ id: 'a', role: 'primary', title: 'A', children: 'a' })}
				{pane({ id: 'b', role: 'navigation', title: 'B', children: 'b' })}
				{pane({ id: 'c', role: 'inspector', title: 'C', children: 'c' })}
				{pane({ id: 'd', role: 'inspector', title: 'D', children: 'd' })}
			</>,
		],
		[
			'percentage default size above the container',
			pane({ id: 'main', role: 'primary', title: 'Editor', defaultSize: '200%', children: 'a' }),
		],
	] as const)('rejects invalid pane contract: %s', async (_label, children) => {
		const container = document.createElement('div')
		const root = createRoot(container)
		mounted.push(root)
		const Renderer = () => null
		const original = console.error
		console.error = vi.fn()
		try {
			await expect(
				act(async () => {
					root.render(
						<WorkbenchViewProvider
							item={{ ownerPluginId: 'Owner', targetPluginId: 'Target' } as never}
							environment={{ locale: { locale: 'zh-CN', subscribe: () => () => {} } } as never}
							paneLayoutRenderer={Renderer}
						>
							<WorkbenchPaneLayout id="layout">{children}</WorkbenchPaneLayout>
						</WorkbenchViewProvider>,
					)
				}),
			).rejects.toThrow(/WorkbenchPane/)
		} finally {
			console.error = original
		}
	})

	it('forwards ordinary navigation separately from document tab creation', async () => {
		const navigate = vi.fn()
		const openTab = vi.fn()
		let host: ReturnType<typeof useWorkbenchHost> | undefined
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		function Probe() {
			host = useWorkbenchHost()
			return null
		}

		await act(async () => {
			root.render(
				<WorkbenchViewProvider
					item={{ ownerPluginId: 'Owner', targetPluginId: 'Target' } as never}
					environment={
						{
							colorScheme: 'dark',
							locale: {
								locale: 'zh-CN',
								subscribe: () => () => {},
							},
						} as never
					}
					navigation={{ navigate, openTab }}
				>
					<Probe />
				</WorkbenchViewProvider>,
			)
		})

		host?.navigation?.navigate('/settings')
		host?.navigation?.openTab({ path: '/accounts/default', title: 'default' })

		expect(navigate).toHaveBeenCalledWith('/settings')
		expect(openTab).toHaveBeenCalledWith({ path: '/accounts/default', title: 'default' })
	})

	it('reports unavailable navigation without exposing methods that only fail on use', async () => {
		let host: ReturnType<typeof useWorkbenchHost> | undefined
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		function Probe() {
			host = useWorkbenchHost()
			return null
		}

		await act(async () => {
			root.render(
				<WorkbenchViewProvider
					item={{ ownerPluginId: 'Owner', targetPluginId: 'Target' } as never}
					environment={{ locale: { locale: 'zh-CN', subscribe: () => () => {} } } as never}
				>
					<Probe />
				</WorkbenchViewProvider>,
			)
		})

		expect(host?.navigation).toBeNull()
	})

	it('is a frozen reflection-safe record backed only by granted resources', async () => {
		const commands = { ping: vi.fn(() => 'pong') }
		let resources: ReturnType<typeof ui.useResources> | undefined
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		function Probe() {
			resources = ui.useResources()
			return null
		}

		await act(async () => {
			root.render(
				<WorkbenchViewProvider
					item={
						{
							viewId: 'Access',
							model: { commands: { kind: 'rpc', grantId: 'commands-grant' } },
						} as never
					}
					environment={
						{
							transport: { workbench: { rpc: () => commands } },
						} as never
					}
				>
					<Probe />
				</WorkbenchViewProvider>,
			)
		})

		expect(resources?.commands).toBe(commands)
		expect(Object.isFrozen(resources)).toBe(true)
		expect(Reflect.get(resources as object, '$$typeof')).toBeUndefined()
		expect(Reflect.get(resources as object, 'missing')).toBeUndefined()
	})
})
