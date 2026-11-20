import { createScriptScope } from '@pluxel/agent-sdk/host'
import { formatPluginNodeReference, type OutboundFetch } from '@pluxel/core'
import type { PluginHost } from '@pluxel/host'
import { Consumer } from './Consumer'
import { Provider } from './Provider'
import { demoConfig } from './demo-config'

export type DemoHost = 'node' | 'browser' | 'cloudflare'
export type DemoResult = {
	host: DemoHost
	plugin: string
	message: string
	source: string
	visits: number
}

export function demoOptions(source: string, fetch?: OutboundFetch) {
	const { provider, consumer, coreConfig } = demoConfig(source, fetch)
	return {
		plugins: [
			{ plugin: Provider, ...provider },
			{ plugin: Consumer, ...consumer },
		],
		coreConfig,
	}
}

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
	kind: DemoHost,
	signal?: AbortSignal,
): Promise<DemoResult> {
	await using scope = createScriptScope({ ctx: host.ctx, signal })
	const address = Consumer.nodeAddress()
	const { instance } = await scope.sdk.plugin(address).instance()
	const greeting = await instance.greet(signal)
	return { host: kind, plugin: formatPluginNodeReference(address), ...greeting }
}
