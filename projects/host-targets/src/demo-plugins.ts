import { Consumer, Provider } from '@pluxel-example/host-targets-plugins'
import type { OutboundFetch } from '@pluxel/core'
import { demoConfig } from './demo-config'

export const consumerAddress = Consumer.nodeAddress()

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
