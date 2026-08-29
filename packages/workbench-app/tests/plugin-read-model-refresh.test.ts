import type { PluginNodeAddress } from '@pluxel/core'
import type { RuntimeManagementClient } from '@pluxel/runtime/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const readModelMocks = vi.hoisted(() => ({
	invalidateGraph: vi.fn(),
	invalidateOverview: vi.fn(),
	refreshGraph: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
	refreshOverview: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}))

vi.mock('../src/app/plugins/pluginDependencyGraph', () => ({
	invalidatePluginDependencyGraph: readModelMocks.invalidateGraph,
	refreshPluginDependencyGraph: readModelMocks.refreshGraph,
}))

vi.mock('../src/app/plugins/pluginOverview', () => ({
	invalidatePluginOverview: readModelMocks.invalidateOverview,
	refreshPluginOverview: readModelMocks.refreshOverview,
}))

import { refreshPluginReadModels } from '../src/app/plugins/pluginReadModels'
import {
	applyPluginLifecycleCommands,
	setPluginAutoStarts,
} from '../src/app/plugins/pluginStatusActions'

const address = {
	definition: {
		entry: { kind: 'package-root', packageName: '@fixture/read-model-refresh' },
		exportName: 'FixturePlugin',
	},
	variant: 'default',
} as const satisfies PluginNodeAddress

describe('plugin read model refresh', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('invalidates and refreshes overview and an existing lazy graph together', async () => {
		const client = {} as RuntimeManagementClient

		await refreshPluginReadModels(client)

		expect(readModelMocks.invalidateOverview).toHaveBeenCalledWith(client)
		expect(readModelMocks.invalidateGraph).toHaveBeenCalledWith(client)
		expect(readModelMocks.refreshOverview).toHaveBeenCalledWith(client)
		expect(readModelMocks.refreshGraph).toHaveBeenCalledWith(client)
	})

	it.each([
		{ label: 'successful', result: { address, ok: true, status: 'applied' } },
		{
			label: 'persistence-unknown',
			result: {
				address,
				ok: false,
				code: 'persistence_failed',
				state: 'unknown',
				error: 'persistence outcome unknown',
			},
		},
	])('forces committed read-model alignment after a $label status mutation', async ({ result }) => {
		const client = {
			plugins: {
				setAutoStart: vi.fn().mockResolvedValue({ results: [result] }),
			},
		} as unknown as RuntimeManagementClient

		await setPluginAutoStarts(client, [{ address, autoStart: true }])

		expect(readModelMocks.refreshOverview).toHaveBeenCalledOnce()
		expect(readModelMocks.refreshGraph).toHaveBeenCalledOnce()
	})

	it('does not invalidate graph facts after an unchanged rejection', async () => {
		const client = {
			plugins: {
				applyLifecycleCommands: vi.fn().mockResolvedValue({
					results: [
						{
							address,
							ok: false,
							code: 'graph_rejected',
							state: 'unchanged',
							error: 'cycle',
						},
					],
				}),
			},
		} as unknown as RuntimeManagementClient

		await applyPluginLifecycleCommands(client, [{ address, command: 'start' }])

		expect(readModelMocks.invalidateOverview).not.toHaveBeenCalled()
		expect(readModelMocks.invalidateGraph).not.toHaveBeenCalled()
	})
})
