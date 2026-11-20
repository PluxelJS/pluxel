import type { PluginNodeAddress } from '@pluxel/core'
import type { QueryClient } from '@tanstack/react-query'
import type { PluginControlBatchResult, RuntimeManagementClient } from '../../runtime'
import { refreshPluginReadModels } from './pluginReadModels'

export type PluginLifecycleCommand = 'start' | 'stop' | 'restart'

async function alignControlReadModels(
	queryClient: QueryClient,
	batch: PluginControlBatchResult,
): Promise<void> {
	if (
		batch.status !== 'rejected' ||
		batch.results.some((result) => result.ok === false && result.code === 'revision_conflict')
	)
		await refreshPluginReadModels(queryClient)
}

export async function setPluginAutoStarts(
	client: RuntimeManagementClient,
	queryClient: QueryClient,
	actions: readonly Readonly<{ address: PluginNodeAddress; autoStart: boolean }>[],
	expectedManagedRevision: string,
): Promise<PluginControlBatchResult> {
	let payload: Awaited<ReturnType<RuntimeManagementClient['plugins']['setAutoStart']>>
	try {
		payload = await client.plugins.setAutoStart(actions, { expectedManagedRevision })
	} catch (error) {
		await refreshPluginReadModels(queryClient)
		throw error
	}
	if ('code' in payload && payload.code === 'invalid_input') return payload
	if (payload.results.length !== actions.length) {
		await refreshPluginReadModels(queryClient)
		throw new Error('运行时返回的自动启动策略结果数量与请求不一致')
	}
	await alignControlReadModels(queryClient, payload)
	return payload
}

export async function setPluginAutoStart(
	client: RuntimeManagementClient,
	queryClient: QueryClient,
	address: PluginNodeAddress,
	autoStart: boolean,
	expectedManagedRevision: string,
): Promise<PluginControlBatchResult> {
	return setPluginAutoStarts(client, queryClient, [{ address, autoStart }], expectedManagedRevision)
}

export async function applyPluginLifecycleCommands(
	client: RuntimeManagementClient,
	queryClient: QueryClient,
	commands: readonly Readonly<{
		address: PluginNodeAddress
		command: PluginLifecycleCommand
	}>[],
): Promise<PluginControlBatchResult> {
	let payload: Awaited<ReturnType<RuntimeManagementClient['plugins']['applyLifecycleCommands']>>
	try {
		payload = await client.plugins.applyLifecycleCommands(commands)
	} catch (error) {
		await refreshPluginReadModels(queryClient)
		throw error
	}
	if ('code' in payload && payload.code === 'invalid_input') return payload
	if (payload.results.length !== commands.length) {
		await refreshPluginReadModels(queryClient)
		throw new Error('运行时返回的生命周期命令结果数量与请求不一致')
	}
	await alignControlReadModels(queryClient, payload)
	return payload
}

export async function applyPluginLifecycleCommand(
	client: RuntimeManagementClient,
	queryClient: QueryClient,
	address: PluginNodeAddress,
	command: PluginLifecycleCommand,
): Promise<PluginControlBatchResult> {
	return applyPluginLifecycleCommands(client, queryClient, [{ address, command }])
}
