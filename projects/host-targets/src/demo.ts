import { createScriptScope } from '@pluxel/agent-sdk/host'
import type { Consumer } from '@pluxel-example/host-targets-plugins'
import { formatPluginNodeReference, type PluginInstanceNodeAddress } from '@pluxel/core'
import type { PluginHost } from '@pluxel/host'
import type { DemoHost, DemoResult } from './protocol'

type ConsumerAddress =
	| PluginInstanceNodeAddress<Consumer>
	| ReturnType<typeof import('@pluxel-example/host-targets-plugins/control').Consumer.nodeAddress>

export async function startDemo(host: PluginHost): Promise<void> {
	await host.start()
	const status = await host.status()
	const unavailable = status.statuses.filter(
		(node) => node.desiredState === 'running' && node.lifecycleState !== 'running',
	)
	if (unavailable.length > 0) {
		const reasons = unavailable.flatMap((node) => node.issues.map((issue) => issue.message))
		throw new Error(reasons.join('\n') || 'The required plugins did not start')
	}
}

export async function runDemo(
	host: PluginHost,
	{ address, target, signal }: { address: ConsumerAddress; target: DemoHost; signal?: AbortSignal },
): Promise<DemoResult> {
	await using scope = createScriptScope({ ctx: host.ctx, signal })
	const { instance } = await scope.sdk.plugin(address).instance()
	const greeting = await instance.greet(signal)
	return { host: target, plugin: formatPluginNodeReference(address), ...greeting }
}
