import { createHost } from '@pluxel/host'
import { demoOptions, runDemo, startDemo } from './demo'
import { nodeFetch, nodeSource } from './demo-config'

await using host = await createHost(demoOptions(nodeSource, nodeFetch))
await startDemo(host)
process.stdout.write(JSON.stringify(await runDemo(host, 'node')) + '\n')
