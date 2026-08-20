import { scaffoldError } from './errors'

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/

export function isTemplateVariableName(value: string): boolean {
	return KEY_PATTERN.test(value)
}

export function renderTemplateValue(
	input: string,
	data: Readonly<Record<string, string>>,
	label: string,
): string {
	try {
		return interpolate(input, data)
	} catch (error) {
		if (error instanceof Error && 'code' in error) throw error
		throw scaffoldError(
			'TEMPLATE_RENDER_INVALID',
			`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`,
			error,
		)
	}
}

function interpolate(input: string, data: Readonly<Record<string, string>>): string {
	let cursor = 0
	let output = ''
	while (cursor < input.length) {
		const open = input.indexOf('{{', cursor)
		const strayClose = input.indexOf('}}', cursor)
		if (strayClose !== -1 && (open === -1 || strayClose < open)) {
			throw new Error('Unexpected closing token "}}"')
		}
		if (open === -1) {
			output += input.slice(cursor)
			break
		}
		output += input.slice(cursor, open)
		const close = input.indexOf('}}', open + 2)
		if (close === -1) throw new Error('Unclosed template token')
		const body = input.slice(open + 2, close).trim()
		if (!body || body.includes('{{')) throw new Error(`Malformed template token: {{${body}}}`)
		const parts = body.split(/\s+/)
		let helper: string | undefined
		let key: string
		if (parts.length === 1) {
			key = parts[0]!
		} else if (parts.length === 2) {
			;[helper, key] = parts as [string, string]
		} else {
			throw new Error(`Malformed template token: {{ ${body} }}`)
		}
		if (!isTemplateVariableName(key)) throw new Error(`Invalid template key: ${key}`)
		const value = data[key]
		if (value === undefined) throw new Error(`Unknown template key: ${key}`)
		if (helper === undefined) output += value
		else if (helper === 'json') output += JSON.stringify(value)
		else throw new Error(`Unknown template helper: ${helper}`)
		cursor = close + 2
	}
	return output
}
