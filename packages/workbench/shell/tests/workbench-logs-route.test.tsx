// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import {
	formatPluginNodeReference,
	parsePluginNodeReference,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router'
import { act } from 'react'
import { RuntimeManagementClientProvider, type RuntimeManagementClient } from '../src/runtime'
import { ManagementQueryProvider } from '../src/app/managementQuery'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LogsPage } from '../src/app/log_viewer/LogsPage'
import { WorkbenchNavigationProvider } from '../src/app/workbench/context'
import { validateLogsSearch } from '../src/app/router/logsSearch'
import { buildPluginLogsHref } from '../src/workbench/paths'
import { prepareNativeWorkbenchDom } from './helpers/native-workbench'

vi.mock('../src/app/log_viewer/LogList', () => ({ LogList: () => null }))
vi.mock('../src/app/log_viewer/LogPolicyPopover', () => ({
	LogPolicyPopover: ({ owner }: { owner: PluginNodeAddress }) => (
		<button type="button" data-policy-owner={formatPluginNodeReference(owner)}>
			日志级别
		</button>
	),
}))
vi.mock('../src/app/plugins/pluginOverview', () => ({
	usePluginOverview: () => ({
		overview: { status: { statuses: [{ address: owner, label: 'Orders East' }] } },
	}),
}))
const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/orders' },
		exportName: 'OrdersPlugin',
	},
	variant: 'fork',
	forkId: 'east-a',
}
const follow = vi.fn(async () => ({ [Symbol.dispose]: vi.fn() }))
const client = {
	logs: {
		follow,
		streams: vi.fn(async () => ({ streams: [{ streamId: 'default' }, { streamId: 'audit' }] })),
		meta: vi.fn(async () => ({
			streamId: 'default',
			bootId: 'test',
			epoch: 1,
			headSeq: '1',
			tailSeq: '0',
			nextSeq: '1',
			count: 0,
			retention: { windowLines: 1000 },
		})),
		range: vi.fn(),
	},
} as unknown as RuntimeManagementClient
const roots: Root[] = []
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

describe('plugin log document URL', () => {
	it('round-trips canonical default and fork references without losing fragment or encoded characters', () => {
		for (const target of [owner, { definition: owner.definition, variant: 'default' as const }]) {
			const url = new URL(buildPluginLogsHref(target), 'https://workbench.invalid')
			expect(url.pathname).toBe('/logs')
			expect(url.hash).toBe('')
			const search = validateLogsSearch(Object.fromEntries(url.searchParams))
			expect(parsePluginNodeReference(search.plugin!)).toEqual(target)
		}
		expect(validateLogsSearch({})).toEqual({})
	})

	it('rejects invalid explicit filters instead of silently showing every plugin', () => {
		for (const plugin of ['', 'OrdersPlugin', ['a'], 42, ' package:@test/orders::OrdersPlugin'])
			expect(() => validateLogsSearch({ plugin })).toThrow(TypeError)
	})

	it('restores a filter from a fresh router, keeps policy scoped, and clears it through the URL', async () => {
		prepareNativeWorkbenchDom()
		const rootRoute = createRootRoute()
		const logsRoute = createRoute({
			getParentRoute: () => rootRoute,
			path: '/logs',
			validateSearch: validateLogsSearch,
			component: () => <LogsPage search={logsRoute.useSearch()} />,
		})
		const router = createRouter({
			routeTree: rootRoute.addChildren([logsRoute]),
			history: createMemoryHistory({
				initialEntries: [buildPluginLogsHref(owner) + '&category=bot.*&context=east'],
			}),
		})
		const container = document.body.appendChild(document.createElement('div'))
		const root = createRoot(container)
		roots.push(root)
		await act(async () => {
			await router.load()
			root.render(
				<MantineProvider env="test">
					<RuntimeManagementClientProvider client={client}>
						<ManagementQueryProvider>
							<WorkbenchNavigationProvider
								value={{
									navigate: (path) => {
										void router.navigate({ to: path })
									},
									openTab: vi.fn(),
								}}
							>
								<RouterProvider router={router} />
							</WorkbenchNavigationProvider>
						</ManagementQueryProvider>
					</RuntimeManagementClientProvider>
				</MantineProvider>,
			)
		})
		expect(follow).toHaveBeenLastCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ plugin: owner, category: 'bot.*', context: 'east' }),
			}),
			expect.any(Function),
		)
		expect(container.querySelector('[data-policy-owner]')?.getAttribute('data-policy-owner')).toBe(
			formatPluginNodeReference(owner),
		)
		expect(container.textContent).toContain('Orders East')

		await act(async () => {
			;[...container.querySelectorAll('button')]
				.find((button) => button.textContent?.startsWith('筛选'))!
				.click()
		})
		const input = document.querySelector<HTMLInputElement>('input[placeholder="例如 bot.*"]')!
		expect(input.value).toBe('bot.*')
		const priorCalls = follow.mock.calls.length
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
				input,
				'changed.*',
			)
			input.dispatchEvent(new Event('input', { bubbles: true }))
		})
		expect(follow).toHaveBeenCalledTimes(priorCalls)
		await act(async () => {
			;[...document.querySelectorAll('button')]
				.find((button) => button.textContent === '应用筛选')!
				.click()
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		expect(router.state.location.search).toEqual({
			plugin: formatPluginNodeReference(owner),
			category: 'changed.*',
			context: 'east',
		})
		expect(follow).toHaveBeenLastCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ plugin: owner, category: 'changed.*' }),
			}),
			expect.any(Function),
		)
		await act(async () => {
			;[...container.querySelectorAll('button')]
				.find((button) => button.textContent?.startsWith('筛选'))!
				.click()
		})
		await act(async () => {
			;[...document.querySelectorAll('button')]
				.find((button) => button.textContent === '清除附加筛选')!
				.click()
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		expect(router.state.location.search).toEqual({ plugin: formatPluginNodeReference(owner) })
		expect(follow).toHaveBeenLastCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ plugin: owner, category: undefined, context: undefined }),
			}),
			expect.any(Function),
		)
		await act(async () => {
			await router.navigate({ to: buildPluginLogsHref(owner) + '&category=bot.*&context=east' })
		})
		const clear = [...container.querySelectorAll('button')].find(
			(button) => button.textContent === '清除插件筛选',
		)!
		await act(async () => {
			clear.click()
			await new Promise((resolve) => setTimeout(resolve, 0))
		})
		expect(router.state.location.search).toEqual({ category: 'bot.*', context: 'east' })
		expect(follow).toHaveBeenLastCalledWith(
			expect.objectContaining({
				filter: expect.objectContaining({ plugin: undefined, category: 'bot.*', context: 'east' }),
			}),
			expect.any(Function),
		)
		expect(container.querySelector('[data-policy-owner]')).toBeNull()
	})
})
