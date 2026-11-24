import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { openControl } from '@pluxel/agent-sdk/control'

const { values, positionals } = parseArgs({
	options: { service: { type: 'boolean' }, config: { type: 'boolean' } },
	allowPositionals: true,
})
const [root = fileURLToPath(new URL('../dist/control/', import.meta.url)), reference, member] =
	positionals
if (positionals.length > 3 || (values.config && (!reference || values.service || member)))
	throw new Error('Usage: control.mjs [root [reference [member]]] [--service | --config]')
using control = await openControl(root)
let result
if (values.config) result = await control.inspectConfig(reference)
else if (values.service)
	result = reference ? await control.inspectService(reference, { member }) : control.services
else
	result = reference
		? await control.inspectPlugin(reference, { member })
		: [...control.plugins, ...control.services]
console.log(JSON.stringify(result, null, 2))
