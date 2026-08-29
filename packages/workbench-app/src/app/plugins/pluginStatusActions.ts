import type { PluginNodeAddress } from '@pluxel/core'
import type { RuntimeManagementClient } from '../../runtime'
import { refreshPluginReadModels } from './pluginReadModels'

export type PluginLifecycleCommand = 'start' | 'stop' | 'restart'

function shouldRefreshControlResult(result: { ok: boolean; state?: string }): boolean {
	return result.ok || result.state === 'unknown'
}

async function alignControlReadModels(
	client: RuntimeManagementClient,
	results: readonly Readonly<{ ok: boolean; state?: string }>[],
): Promise<void> {
	if (results.some(shouldRefreshControlResult)) await refreshPluginReadModels(client)
}

export async function setPluginAutoStarts(
	client: RuntimeManagementClient,
	actions: readonly Readonly<{ address: PluginNodeAddress; autoStart: boolean }>[],
) {
	if (actions.length === 0) return []
	const payload = await client.plugins.setAutoStart(actions)
	const results = payload.results
	if (results.length !== actions.length) {
		throw new Error('运行时返回的自动启动策略结果数量与请求不一致')
	}
	await alignControlReadModels(client, results)
	return results
}

export async function setPluginAutoStart(
	client: RuntimeManagementClient,
	address: PluginNodeAddress,
	autoStart: boolean,
) {
	const results = await setPluginAutoStarts(client, [{ address, autoStart }])
	const first = results[0]
	if (!first) throw new Error('运行时未返回自动启动策略结果')
	return first
}

export async function applyPluginLifecycleCommands(
	client: RuntimeManagementClient,
	commands: readonly Readonly<{
		address: PluginNodeAddress
		command: PluginLifecycleCommand
	}>[],
) {
	if (commands.length === 0) return []
	const payload = await client.plugins.applyLifecycleCommands(commands)
	const results = payload.results
	if (results.length !== commands.length) {
		throw new Error('运行时返回的生命周期命令结果数量与请求不一致')
	}
	await alignControlReadModels(client, results)
	return results
}

export async function applyPluginLifecycleCommand(
	client: RuntimeManagementClient,
	address: PluginNodeAddress,
	command: PluginLifecycleCommand,
) {
	const results = await applyPluginLifecycleCommands(client, [{ address, command }])
	const first = results[0]
	if (!first) throw new Error('运行时未返回生命周期命令结果')
	return first
}
