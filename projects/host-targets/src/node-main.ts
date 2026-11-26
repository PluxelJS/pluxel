import { startHost } from '@pluxel/host'
import * as plugins from '@pluxel-example/host-targets-plugins'
import { demoApplication, runDemo } from './demo'
import { nodeFetch, nodeSource } from './demo-config'

await using host = await startHost(demoApplication(plugins, nodeFetch), {
	env: { GREETING_SOURCE: nodeSource, GREETING_NAME: process.env.GREETING_NAME },
})
const result = await runDemo(host, { address: plugins.Consumer.nodeAddress(), target: 'node' })
process.stdout.write(JSON.stringify(result) + '\n')
