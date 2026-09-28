import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { checkCompletions } from './lsp-probe.mjs'
const root = dirname(fileURLToPath(import.meta.url))
console.log(
	JSON.stringify(
		await checkCompletions({
			root,
			compiler: resolve(root, '../../../node_modules/typescript/bin/tsc'),
			filename: resolve(root, 'explicit-consumer.ts'),
		}),
		null,
		2,
	),
)
