// @vitest-environment jsdom

import type { PluginNodeAddress } from '@pluxel/core'
import { MantineProvider } from '@mantine/core'
import type {
	PluginDependencyGraphSnapshot,
	PluginCatalogSnapshot,
	PluginStatusSnapshot,
	RuntimeManagementClient,
} from '@pluxel/services/management/client'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { prepareReactDom } from '../fixtures/react-dom'
import { RuntimeManagementClientProvider } from '../../src/runtime'
import { QueryClientProvider } from '@tanstack/react-query'
import { usePluginDetail } from '../../src/app/plugins/detail/usePluginDetail'
import { createManagementQueryClient, managementQueryKeys } from '../../src/app/managementQuery'
import { PluginScopeProvider } from '../../src/app/plugins/detail/context'
import { ActionBar } from '../../src/app/plugins/detail/controls/ActionBar'
import { BulkActionsBar } from '../../src/app/plugins/catalog/components/BulkActionsBar'
import { buildPluginOverview } from '../../src/app/plugins/pluginOverviewModel'
import type { PluginDependencyGraphProjection } from '../../src/app/plugins/pluginDependencyGraphModel'
import { controlCatalog } from '../fixtures/plugin-controls'

const owner = node('OwnerPlugin')
const ownerStatus = status(owner)
const oldGraph = graph(ownerStatus)
const committedAfterMutation = graph({
	...ownerStatus,
	autoStart: false,
	desiredState: 'stopped',
	activationReason: null,
	lifecycleState: 'stopped',
})
const mounted: Array<ReturnType<typeof createRoot>> = []

beforeAll(prepareReactDom)

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

describe('plugin detail refresh', () => {
	it('disables declared auto-start controls while keeping session controls and selection usable', async () => {
		const snapshot: PluginCatalogSnapshot = {
			...pluginCatalog(ownerStatus),
			statePolicy: {
				...controlCatalog().statePolicy,
				selections: [
					{
						target: { field: 'autoStart', node: owner },
						mode: 'declared-first',
						source: 'declared',
						shadowed: false,
					},
				],
			},
		}
		const client = {
			catalog: { snapshot: vi.fn().mockResolvedValue(snapshot) },
		} as unknown as RuntimeManagementClient
		const queryClient = createManagementQueryClient()
		queryClient.setQueryData(managementQueryKeys.pluginOverview(), buildPluginOverview(snapshot))
		const onBulkAction = vi.fn()
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)
		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={queryClient}>
						<MantineProvider>
							<PluginScopeProvider
								value={{
									owner,
									pluginRoute: ownerStatus.route,
									pluginLabel: ownerStatus.displayName,
									description: '',
									dependencyGraph: { detail: null, isLoading: false, isStale: false },
									status: buildPluginOverview(snapshot).status.statuses[0]!,
									refetch: async () => {},
								}}
							>
								<ActionBar />
								<BulkActionsBar
									count={1}
									busy={false}
									canChangeAutoStart={false}
									onAction={onBulkAction}
								/>
							</PluginScopeProvider>
						</MantineProvider>
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
		})
		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.disabled).toBe(true)
		const bulkOn = container.querySelector<HTMLButtonElement>('button[aria-label="开启自动启动"]')!
		const bulkOff = container.querySelector<HTMLButtonElement>('button[aria-label="关闭自动启动"]')!
		const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清空选择"]')!
		expect(bulkOn.disabled).toBe(true)
		expect(bulkOff.disabled).toBe(true)
		expect(clear.disabled).toBe(false)
		const lifecycle = [
			...container.querySelectorAll<HTMLButtonElement>(
				'.plx-pluginWorkbench__lifecycleActions button',
			),
		]
		expect(lifecycle.map((button) => [button.textContent, button.disabled])).toEqual([
			['停止', false],
			['重启', false],
		])
		await act(async () => {
			bulkOn.click()
			bulkOff.click()
			clear.click()
		})
		expect(onBulkAction).toHaveBeenCalledExactlyOnceWith('clear')
	})

	it('keeps the refreshed dependency graph after an older transport read returns', async () => {
		const oldRead = Promise.withResolvers<PluginDependencyGraphSnapshot>()
		const graphRead = vi
			.fn<() => Promise<PluginDependencyGraphSnapshot>>()
			.mockReturnValueOnce(oldRead.promise)
			.mockResolvedValueOnce(committedAfterMutation)
		const client = {
			catalog: { snapshot: vi.fn().mockResolvedValue(pluginCatalog(ownerStatus)) },
			dependencies: { graph: graphRead },
		} as unknown as RuntimeManagementClient
		let detail: ReturnType<typeof usePluginDetail> | undefined

		function Probe() {
			detail = usePluginDetail(ownerStatus.route)
			return null
		}

		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		const queryClient = createManagementQueryClient()
		mounted.push(root)
		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={queryClient}>
						<Probe />
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
		})
		expect(graphRead).toHaveBeenCalledOnce()

		await act(async () => detail!.refetch())
		expect(graphRead).toHaveBeenCalledTimes(2)

		await act(async () => {
			oldRead.resolve(oldGraph)
			await oldRead.promise
		})

		const cached = queryClient.getQueryData<PluginDependencyGraphProjection>(
			managementQueryKeys.pluginDependencyGraph(),
		)
		expect(cached?.snapshot).toEqual(committedAfterMutation)
	})
})

function node(exportName: string): PluginNodeAddress {
	return {
		definition: {
			entry: { kind: 'package-root', packageName: '@fixture/plugin-detail-refresh' },
			exportName,
		},
		variant: 'default',
	}
}

function status(address: PluginNodeAddress): PluginStatusSnapshot {
	const name = address.definition.exportName
	return {
		address,
		reference: `package:@fixture/plugin-detail-refresh::${name}`,
		route: `v1/package/${name}/@fixture/plugin-detail-refresh`,
		displayName: name,
		label: { title: name, text: name },
		rootExportName: name,
		autoStart: true,
		sessionIntent: 'inherit',
		desiredState: 'running',
		activationReason: 'auto-start',
		lifecycleState: 'running',
		availability: 'available',
		issues: [],
		execution: {
			kind: 'unreported',
			artifact: { kind: 'unreported' },
			update: { kind: 'unreported' },
		},
		recentUpdate: null,
	}
}

function graph(nodeStatus: PluginStatusSnapshot): PluginDependencyGraphSnapshot {
	return Object.freeze({
		nodes: Object.freeze([Object.freeze({ status: nodeStatus, effective: true })]),
		edges: Object.freeze([]),
	})
}

function pluginCatalog(nodeStatus: PluginStatusSnapshot): PluginCatalogSnapshot {
	return {
		plugins: [nodeStatus],
		sections: [],
		statePolicy: controlCatalog().statePolicy,
		summary: { total: 1, running: 1, stopped: 0, autoStart: 1 },
	}
}
