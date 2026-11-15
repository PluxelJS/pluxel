import { fileURLToPath } from 'node:url'
import { inspectPlugin } from '@pluxel/agent-sdk/source'

const root = fileURLToPath(new URL('..', import.meta.url))
const report = await inspectPlugin('package:@example/todo-plugin::TodoPlugin', {
	root,
	application: { root: 'host', entry: 'src/app.ts' },
	include: ['config', 'parts', 'inputs', 'checks'],
})
console.log(JSON.stringify(report, null, 2))
