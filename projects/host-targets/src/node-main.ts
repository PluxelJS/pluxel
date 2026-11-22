import { startHost } from '@pluxel/host'
import * as plugins from '@pluxel-example/host-targets-plugins'
import { runDemo } from './demo'
import { demoConfig, nodeFetch, nodeSource } from './demo-config'
import { demoApplication } from './demo-plugins'

await using host = await startHost(demoApplication(plugins), {
	env: { GREETING_SOURCE: nodeSource },
	coreConfig: demoConfig(nodeSource, nodeFetch).coreConfig,
})
const result = await runDemo(host, { address: plugins.Consumer.nodeAddress(), target: 'node' })
process.stdout.write(JSON.stringify(result) + '\n')
