import { startHost } from '@pluxel/host'
import * as plugins from '@pluxel-example/host-targets-plugins'
import { demoApplication, demoInputs, runDemo } from './demo'
import { nodeFetch, nodeSource } from './demo-config'

await using host = await startHost(
	demoApplication(plugins, 'node'),
	demoInputs({ GREETING_SOURCE: nodeSource, HOST_PROBE: process.env.HOST_PROBE }, nodeFetch),
)
const result = await runDemo(host, { address: plugins.Consumer.nodeAddress(), target: 'node' })
process.stdout.write(JSON.stringify(result) + '\n')
