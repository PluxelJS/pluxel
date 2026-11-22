import { defineHostApplication } from '@pluxel/host'
import { Consumer, Provider } from '@pluxel-example/host-targets-plugins/control'
import { runDemo } from './demo'
import { demoConfig, nodeFetch, nodeSource } from './demo-config'

const consumerAddress = Consumer.nodeAddress()

export default defineHostApplication((startup) => {
	const { provider, consumer, coreConfig } = demoConfig(nodeSource, nodeFetch)
	return {
		sources: [{ file: './plugins/src/index.ts' }],
		pluginNodes: [
			{ definition: Provider.address(), ...provider },
			{ definition: Consumer.address(), ...consumer },
		],
		coreConfig,
		prepare({ host }) {
			const serve = startup.bindings.serve
			if (typeof serve !== 'function') throw new TypeError('The Node demo endpoint is required')
			host.ctx.effects.defer(
				serve((signal: AbortSignal) =>
					runDemo(host, { address: consumerAddress, target: 'node', signal }),
				),
			)
		},
	}
})
