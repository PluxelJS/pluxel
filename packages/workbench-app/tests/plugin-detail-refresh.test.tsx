// @vitest-environment jsdom

import type { PluginNodeAddress } from '@pluxel/core'
import type {
	PluginDependencyGraphSnapshot,
	PluginCatalogSnapshot,
	PluginStatusSnapshot,
	RuntimeManagementClient,
} from '@pluxel/runtime/web'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RuntimeManagementClientProvider } from '../src/runtime'
import { QueryClientProvider } from '@tanstack/react-query'
import { usePluginDetail } from '../src/app/plugins/detail/usePluginDetail'
import { createManagementQueryClient } from '../src/app/managementQuery'

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

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

describe('plugin detail refresh', () => {
	it('crosses the invalidation fence when a mutation races an in-flight graph read', async () => {
		let releaseOldGraph!: (value: PluginDependencyGraphSnapshot) => void
		const oldRead = new Promise<PluginDependencyGraphSnapshot>((resolve) => {
			releaseOldGraph = resolve
		})
		const graphRead = vi
			.fn<() => Promise<PluginDependencyGraphSnapshot>>()
			.mockReturnValueOnce(oldRead)
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
			await Promise.resolve()
		})
		expect(graphRead).toHaveBeenCalledOnce()

		let refresh!: Promise<void>
		await act(async () => {
			refresh = detail!.refetch()
			await Promise.resolve()
		})
		expect(graphRead).toHaveBeenCalledTimes(2)

		await act(async () => {
			releaseOldGraph(oldGraph)
			await refresh
		})

		expect(graphRead).toHaveBeenCalledTimes(2)
		expect(detail?.dependencyGraph.isStale).toBe(false)
		expect(detail?.dependencyGraph.detail?.node?.status.lifecycleState).toBe('stopped')
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
		summary: { total: 1, running: 1, stopped: 0, autoStart: 1 },
	}
}
