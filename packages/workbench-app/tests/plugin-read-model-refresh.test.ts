import type { PluginNodeAddress } from '@pluxel/core'
import type { QueryClient } from '@tanstack/react-query'
import type { RuntimeManagementClient } from '@pluxel/runtime/web'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

function queryClientDouble() {
	return {
		cancelQueries: vi.fn().mockResolvedValue(undefined),
		invalidateQueries: vi.fn().mockResolvedValue(undefined),
	} as unknown as QueryClient
}

describe('plugin read model refresh', () => {
	beforeEach(() => vi.clearAllMocks())

	it('cancels stale reads, invalidates both models, and awaits authoritative refetches', async () => {
		const queryClient = queryClientDouble()

		await refreshPluginReadModels(queryClient)

		expect(queryClient.cancelQueries).toHaveBeenCalledTimes(2)
		expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2)
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
		const queryClient = queryClientDouble()
		const client = {
			plugins: { setAutoStart: vi.fn().mockResolvedValue({ results: [result] }) },
		} as unknown as RuntimeManagementClient

		await setPluginAutoStarts(client, queryClient, [{ address, autoStart: true }])

		expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2)
	})

	it('does not invalidate graph facts after an unchanged rejection', async () => {
		const queryClient = queryClientDouble()
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

		await applyPluginLifecycleCommands(client, queryClient, [{ address, command: 'start' }])

		expect(queryClient.invalidateQueries).not.toHaveBeenCalled()
		expect(queryClient.invalidateQueries).not.toHaveBeenCalled()
	})

	it('realigns read models when transport fails after a command may have committed', async () => {
		const queryClient = queryClientDouble()
		const client = {
			plugins: { setAutoStart: vi.fn().mockRejectedValue(new Error('socket closed')) },
		} as unknown as RuntimeManagementClient

		await expect(
			setPluginAutoStarts(client, queryClient, [{ address, autoStart: true }]),
		).rejects.toThrow('socket closed')
		expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2)
	})
})
