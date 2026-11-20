import { definePluginRef } from '@pluxel/core'
import { defineHostApplication } from '@pluxel/host'
import type { Consumer } from './Consumer'
import type { Provider } from './Provider'
import { demoConfig, nodeFetch, nodeSource } from './demo-config'

const providerRef = definePluginRef<Provider>()
const consumerRef = definePluginRef<Consumer>()

export default defineHostApplication(() => {
	const { provider, consumer, coreConfig } = demoConfig(nodeSource, nodeFetch)
	return {
		sources: [{ file: './src/Provider.ts' }, { file: './src/Consumer.ts' }],
		pluginNodes: [
			{ definition: providerRef.definition, ...provider },
			{ definition: consumerRef.definition, ...consumer },
		],
		coreConfig,
		prepare({ host, startup }) {
			const serve = startup.bindings.serve
			if (typeof serve === 'function') host.ctx.effects.defer(serve(host))
		},
	}
})
