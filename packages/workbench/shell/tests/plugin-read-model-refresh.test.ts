import type { QueryClient } from '@tanstack/react-query'
import type {
	PluginControlBatchResult,
	RuntimeManagementClient,
} from '@pluxel/services/management/client'
import { describe, expect, it, vi } from 'vitest'

import { refreshPluginReadModels } from '../src/app/plugins/pluginReadModels'
import {
	applyPluginLifecycleCommand,
	applyPluginLifecycleCommands,
	setPluginAutoStart,
	setPluginAutoStarts,
} from '../src/app/plugins/pluginStatusActions'
import {
	appliedControl,
	controlNode,
	invalidControlBatch,
	lifecycleFailedControl,
	rejectedControl,
	unknownControl,
} from './pluginControlFixtures'

const address = controlNode()
const batches: ReadonlyArray<{
	label: string
	batch: PluginControlBatchResult
	refreshes: number
}> = [
	{
		label: 'applied',
		batch: { ok: true, status: 'applied', results: [appliedControl()] },
		refreshes: 2,
	},
	{
		label: 'partially applied',
		batch: {
			ok: false,
			status: 'partially-applied',
			results: [appliedControl(), rejectedControl('graph_rejected', controlNode('SecondPlugin'))],
		},
		refreshes: 2,
	},
	{
		label: 'applied with issues',
		batch: { ok: false, status: 'applied-with-issues', results: [lifecycleFailedControl()] },
		refreshes: 2,
	},
	{
		label: 'unknown',
		batch: {
			ok: false,
			status: 'unknown',
			results: [appliedControl(), unknownControl(controlNode('SecondPlugin'))],
		},
		refreshes: 2,
	},
	{
		label: 'revision conflict',
		batch: { ok: false, status: 'rejected', results: [rejectedControl('revision_conflict')] },
		refreshes: 2,
	},
	{
		label: 'unchanged rejection',
		batch: { ok: false, status: 'rejected', results: [rejectedControl()] },
		refreshes: 0,
	},
]

function queryClientDouble() {
	return {
		cancelQueries: vi.fn().mockResolvedValue(undefined),
		invalidateQueries: vi.fn().mockResolvedValue(undefined),
	} as unknown as QueryClient
}

function clientDouble(batch: PluginControlBatchResult) {
	return {
		plugins: {
			setAutoStart: vi.fn().mockResolvedValue(batch),
			applyLifecycleCommands: vi.fn().mockResolvedValue(batch),
		},
	} as unknown as RuntimeManagementClient
}

describe('plugin read model refresh', () => {
	it('cancels stale reads, invalidates both models, and awaits authoritative refetches', async () => {
		const queryClient = queryClientDouble()

		await refreshPluginReadModels(queryClient)

		expect(queryClient.cancelQueries).toHaveBeenCalledTimes(2)
		expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2)
	})

	it.each(batches)(
		'preserves the $label batch and aligns affected read models',
		async ({ batch, refreshes }) => {
			const client = clientDouble(batch)
			const autoStartQueries = queryClientDouble()
			const lifecycleQueries = queryClientDouble()
			const actions = batch.results.map((result) => ({ address: result.address, autoStart: true }))
			const commands = batch.results.map((result) => ({
				address: result.address,
				command: 'start' as const,
			}))

			expect(await setPluginAutoStarts(client, autoStartQueries, actions, 'policy:test:0')).toBe(
				batch,
			)
			expect(await applyPluginLifecycleCommands(client, lifecycleQueries, commands)).toBe(batch)

			expect(client.plugins.setAutoStart).toHaveBeenCalledExactlyOnceWith(actions, {
				expectedManagedRevision: 'policy:test:0',
			})
			expect(client.plugins.applyLifecycleCommands).toHaveBeenCalledExactlyOnceWith(commands)
			expect(autoStartQueries.cancelQueries).toHaveBeenCalledTimes(refreshes)
			expect(autoStartQueries.invalidateQueries).toHaveBeenCalledTimes(refreshes)
			expect(lifecycleQueries.cancelQueries).toHaveBeenCalledTimes(refreshes)
			expect(lifecycleQueries.invalidateQueries).toHaveBeenCalledTimes(refreshes)
		},
	)

	it('preserves a server rejection for 1001 actions without splitting or reinterpreting it', async () => {
		const batch = invalidControlBatch()
		const client = clientDouble(batch)
		const queryClient = queryClientDouble()
		const actions = Array.from({ length: 1001 }, (_, index) => ({
			address: controlNode(`Plugin${index}`),
			autoStart: true,
		}))
		const commands = actions.map((action) => ({
			address: action.address,
			command: 'start' as const,
		}))

		expect(await setPluginAutoStarts(client, queryClient, actions, 'policy:test:0')).toBe(batch)
		expect(await applyPluginLifecycleCommands(client, queryClient, commands)).toBe(batch)

		expect(client.plugins.setAutoStart).toHaveBeenCalledExactlyOnceWith(actions, {
			expectedManagedRevision: 'policy:test:0',
		})
		expect(client.plugins.applyLifecycleCommands).toHaveBeenCalledExactlyOnceWith(commands)
		expect(queryClient.invalidateQueries).not.toHaveBeenCalled()
	})

	it('keeps top-level rejections intact for single-operation callers', async () => {
		const batch = invalidControlBatch('Managed policy revision is required')
		const client = clientDouble(batch)
		const queryClient = queryClientDouble()

		expect(await setPluginAutoStart(client, queryClient, address, false, '')).toBe(batch)
		expect(await applyPluginLifecycleCommand(client, queryClient, address, 'stop')).toBe(batch)
		expect(queryClient.invalidateQueries).not.toHaveBeenCalled()
	})

	it.each([
		{ label: 'missing', results: [] },
		{ label: 'extra', results: [appliedControl(), appliedControl(controlNode('ExtraPlugin'))] },
	])(
		'rejects $label execution results and refreshes instead of presenting success',
		async ({ results }) => {
			const client = clientDouble({ ok: true, status: 'applied', results })
			const autoStartQueries = queryClientDouble()
			const lifecycleQueries = queryClientDouble()

			await expect(
				setPluginAutoStart(client, autoStartQueries, address, true, 'policy:test:0'),
			).rejects.toThrow('运行时返回的自动启动策略结果数量与请求不一致')
			await expect(
				applyPluginLifecycleCommand(client, lifecycleQueries, address, 'start'),
			).rejects.toThrow('运行时返回的生命周期命令结果数量与请求不一致')
			expect(client.plugins.setAutoStart).toHaveBeenCalledOnce()
			expect(client.plugins.applyLifecycleCommands).toHaveBeenCalledOnce()
			expect(autoStartQueries.invalidateQueries).toHaveBeenCalledTimes(2)
			expect(lifecycleQueries.invalidateQueries).toHaveBeenCalledTimes(2)
		},
	)

	it('forwards empty batches to the domain owner and returns its receipt', async () => {
		const batch: PluginControlBatchResult = { ok: true, status: 'applied', results: [] }
		const client = clientDouble(batch)
		const queryClient = queryClientDouble()

		expect(await setPluginAutoStarts(client, queryClient, [], 'policy:test:0')).toBe(batch)
		expect(await applyPluginLifecycleCommands(client, queryClient, [])).toBe(batch)
		expect(client.plugins.setAutoStart).toHaveBeenCalledExactlyOnceWith([], {
			expectedManagedRevision: 'policy:test:0',
		})
		expect(client.plugins.applyLifecycleCommands).toHaveBeenCalledExactlyOnceWith([])
	})

	it('realigns read models after transport failure without resubmitting commands', async () => {
		const error = new Error('socket closed')
		const client = {
			plugins: {
				setAutoStart: vi.fn().mockRejectedValue(error),
				applyLifecycleCommands: vi.fn().mockRejectedValue(error),
			},
		} as unknown as RuntimeManagementClient
		const autoStartQueries = queryClientDouble()
		const lifecycleQueries = queryClientDouble()

		await expect(
			setPluginAutoStart(client, autoStartQueries, address, true, 'policy:test:0'),
		).rejects.toBe(error)
		await expect(
			applyPluginLifecycleCommand(client, lifecycleQueries, address, 'start'),
		).rejects.toBe(error)
		expect(client.plugins.setAutoStart).toHaveBeenCalledOnce()
		expect(client.plugins.applyLifecycleCommands).toHaveBeenCalledOnce()
		expect(autoStartQueries.invalidateQueries).toHaveBeenCalledTimes(2)
		expect(lifecycleQueries.invalidateQueries).toHaveBeenCalledTimes(2)
	})
})
