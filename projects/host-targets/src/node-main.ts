import { createHost } from '@pluxel/host'
import { runDemo, startDemo } from './demo'
import { nodeFetch, nodeSource } from './demo-config'
import { consumerAddress, demoOptions } from './demo-plugins'

await using host = await createHost(demoOptions(nodeSource, nodeFetch))
await startDemo(host)
const result = await runDemo(host, { address: consumerAddress, target: 'node' })
process.stdout.write(JSON.stringify(result) + '\n')
