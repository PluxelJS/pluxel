import { fileURLToPath } from 'node:url'
import { inspectPlugin } from '@pluxel/agent-sdk/source'

const root = fileURLToPath(new URL('..', import.meta.url))
const report = await inspectPlugin('source:app/src/showcase/ReportStudio.ts::ReportStudioPlugin', {
	root,
	application: { root: '.', entry: 'src/app.ts' },
	include: ['config', 'parts', 'dependencies', 'inputs', 'checks'],
})
console.log(JSON.stringify(report, null, 2))
