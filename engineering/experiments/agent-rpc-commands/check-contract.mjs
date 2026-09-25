import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const displayKeys = new Set(['description', 'title', 'examples', '$comment'])
const stable = (value) =>
	JSON.stringify(value, (_key, inner) =>
		inner && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
			: inner,
	)
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex')

function authSchema(schema) {
	const result = {}
	for (const [key, value] of Object.entries(schema)) {
		if (displayKeys.has(key)) continue
		if (key === 'properties')
			result[key] = Object.fromEntries(
				Object.entries(value).map(([name, field]) => [name, authSchema(field)]),
			)
		else if (key === 'items') result[key] = authSchema(value)
		else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf')
			result[key] = value.map(authSchema)
		else result[key] = value
	}
	return result
}
function contractHash(methods) {
	return digest({
		protocol: 1,
		publisher: 'plugin:sample',
		id: 'records',
		methods: methods.map(({ method, command, input, success }) => ({
			method,
			command,
			input: authSchema(input),
			success,
		})),
	})
}
const input = {
	type: 'object',
	description: 'write a record',
	properties: {
		id: { type: 'string', description: 'Record ID' },
		count: { type: 'number', default: 1 },
		description: { type: 'string', default: 'business default' },
	},
}
const base = [
	{ method: 'write', command: 'records.write', input, success: '{ operationId: string }' },
]
const approved = contractHash(base)
const changedText = structuredClone(base)
changedText[0].input.description = 'new API copy'
changedText[0].input.properties.id.description = 'new field copy'
assert.equal(contractHash(changedText), approved)
assert.notEqual(digest(changedText), digest(base))
const changedBinding = structuredClone(base)
changedBinding[0].command = 'records.read'
assert.notEqual(contractHash(changedBinding), approved)
const changedDefault = structuredClone(base)
changedDefault[0].input.properties.description.default = 'new business default'
assert.notEqual(contractHash(changedDefault), approved)
const changedMethod = [...base, { ...base[0], method: 'extra' }]
assert.notEqual(contractHash(changedMethod), approved)
console.log(
	JSON.stringify(
		{ approved, textPreservesApproval: true, bindingAndDefaultAndMethodInvalidate: true },
		null,
		2,
	),
)
