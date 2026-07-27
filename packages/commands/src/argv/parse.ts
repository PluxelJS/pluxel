import { CommandError, type CommandContext } from '../types'
import { closestSuggestions, suggestionSuffix, type SuggestionCandidate } from './suggest'
import type { CompiledEntry, CompiledParameter } from './compile'
import type { ArgvTailConfig, ArgvToken } from './types'

export function parseCandidate<Ctx extends CommandContext>(
	entry: CompiledEntry<Ctx>,
	tokens: readonly ArgvToken[],
	start: number,
	input: string,
): Record<string, unknown> {
	const candidate: Record<string, unknown> = {}
	let positionalIndex = 0
	let optionsEnabled = true
	let tailStart = -1

	const assign = (parameter: CompiledParameter, value: unknown) => {
		if (parameter.type === 'array') {
			const values = Object.hasOwn(candidate, parameter.key)
				? (candidate[parameter.key] as unknown[])
				: defineCandidateValue(candidate, parameter.key, [])
			if (Array.isArray(value)) values.push(...value)
			else values.push(value)
			return
		}
		if (Object.hasOwn(candidate, parameter.key)) {
			throw syntaxError(`Parameter "${parameter.name}" was provided more than once`, {
				reason: 'duplicate_parameter',
				parameter: parameter.name,
			})
		}
		defineCandidateValue(candidate, parameter.key, value)
	}

	for (let index = start; index < tokens.length; index += 1) {
		const token = tokens[index]!
		if (optionsEnabled && token.value === '--') {
			optionsEnabled = false
			continue
		}
		if (optionsEnabled && token.value.startsWith('--') && token.value.length > 2) {
			const body = token.value.slice(2)
			const separator = body.indexOf('=')
			const name = separator >= 0 ? body.slice(0, separator) : body
			let parameter = entry.optionAliases.get(normalizeParameterName(name))
			if (!parameter && separator < 0 && name.startsWith('no-')) {
				parameter = entry.optionAliases.get(normalizeParameterName(name.slice(3)))
				if (!parameter || parameter.type !== 'boolean') {
					throw unknownParameter(entry, token, name)
				}
				assign(parameter, false)
				continue
			}
			if (!parameter) throw unknownParameter(entry, token, name)
			if (parameter.type === 'boolean' && separator < 0) {
				const next = tokens[index + 1]
				if (!next || looksLikeOption(next) || !booleanValues.has(next.value.toLowerCase())) {
					assign(parameter, true)
					continue
				}
			}
			const raw = separator >= 0 ? body.slice(separator + 1) : tokens[++index]?.value
			if (raw === undefined) {
				throw syntaxError(`Missing value for "--${name}"`, {
					reason: 'missing_value',
					parameter: name,
				})
			}
			assign(parameter, coerce(parameter, raw))
			continue
		}
		if (optionsEnabled && /^-[^-]/.test(token.value)) {
			const body = token.value.slice(1)
			const grouped = [...body].map((name) => entry.optionAliases.get(normalizeParameterName(name)))
			if (body.length > 1 && grouped.every((parameter) => parameter?.type === 'boolean')) {
				for (const parameter of grouped) assign(parameter!, true)
				continue
			}
			const separator = body.indexOf('=')
			const name = separator >= 0 ? body.slice(0, separator) : body
			if (name.length !== 1) throw unknownParameter(entry, token, name)
			const parameter = entry.optionAliases.get(normalizeParameterName(name))
			if (!parameter) throw unknownParameter(entry, token, name)
			if (parameter.type === 'boolean' && separator < 0) {
				const next = tokens[index + 1]
				if (!next || looksLikeOption(next) || !booleanValues.has(next.value.toLowerCase())) {
					assign(parameter, true)
					continue
				}
			}
			const raw = separator >= 0 ? body.slice(separator + 1) : tokens[++index]?.value
			if (raw === undefined) {
				throw syntaxError(`Missing value for "-${name}"`, {
					reason: 'missing_value',
					parameter: name,
				})
			}
			assign(parameter, coerce(parameter, raw))
			continue
		}
		const positional = entry.positionals[positionalIndex]
		if (positional) {
			assign(positional, coerce(positional, token.value))
			positionalIndex += 1
			continue
		}
		if (entry.tail) {
			tailStart = index
			break
		}
		throw syntaxError(`Unexpected positional argument "${token.value}"`, {
			reason: 'unexpected_positional',
			at: { start: token.start, end: token.end, raw: token.raw },
		})
	}

	if (entry.tail && tailStart >= 0) {
		const raw = tailStart < tokens.length ? input.slice(tokens[tailStart]!.start) : ''
		applyTail(entry.tail, candidate, raw)
	}
	return candidate
}

function applyTail(
	tail: ArgvTailConfig<any>,
	candidate: Record<string, unknown>,
	raw: string,
): void {
	if (tail.mode === 'text') {
		defineCandidateValue(candidate, String(tail.key), raw.trim())
		return
	}
	defineCandidateValue(candidate, String(tail.key), parseJson(raw, String(tail.key)))
}

function defineCandidateValue<T>(candidate: Record<string, unknown>, key: string, value: T): T {
	Object.defineProperty(candidate, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	})
	return value
}

const booleanValues = new Map<string, boolean>([
	['true', true],
	['1', true],
	['yes', true],
	['on', true],
	['false', false],
	['0', false],
	['no', false],
	['off', false],
])

function coerce(parameter: CompiledParameter, raw: string): unknown {
	const type = parameter.type === 'array' ? parameter.itemType! : parameter.type
	switch (type) {
		case 'string':
			if (parameter.choices && !parameter.choices.includes(raw)) {
				throw invalidChoice(parameter, raw)
			}
			return raw
		case 'number': {
			const value = Number(raw)
			if (!Number.isFinite(value)) throw invalidValue(parameter, 'number')
			return value
		}
		case 'integer': {
			const value = Number(raw)
			if (!Number.isInteger(value)) throw invalidValue(parameter, 'integer')
			return value
		}
		case 'boolean': {
			const value = booleanValues.get(raw.toLowerCase())
			if (value === undefined) throw invalidValue(parameter, 'boolean')
			return value
		}
		case 'json':
			return parseJson(raw, parameter.name)
	}
}

function parseJson(raw: string, parameter: string): unknown {
	try {
		return JSON.parse(raw)
	} catch (error) {
		throw new CommandError('ARGUMENT_SYNTAX', 'Invalid command input', {
			message: `Invalid JSON for "${parameter}"`,
			details: { reason: 'invalid_json', parameter },
			cause: error,
		})
	}
}

function normalizeParameterName(value: string): string {
	return value.replaceAll('_', '-').toLowerCase()
}

function looksLikeOption(token: ArgvToken): boolean {
	return token.value === '--' || /^--?[^-]/.test(token.value)
}

function unknownParameter<Ctx extends CommandContext>(
	entry: CompiledEntry<Ctx>,
	token: ArgvToken,
	name: string,
): CommandError<'ARGUMENT_SYNTAX'> {
	const candidates: SuggestionCandidate[] = []
	for (const parameter of new Set(entry.optionAliases.values())) {
		for (const optionName of parameter.optionNames) {
			candidates.push({
				compare: name,
				display: optionName.length === 1 ? `-${optionName}` : `--${optionName}`,
			})
		}
	}
	const suggestions = closestSuggestions(candidates, {
		normalize: normalizeParameterName,
		displayToComparable: (display) => display.replace(/^--?/, ''),
	})
	return syntaxError(`Unknown option "${token.raw}"${suggestionSuffix(suggestions)}`, {
		reason: 'unknown_parameter',
		parameter: name,
		at: { start: token.start, end: token.end, raw: token.raw },
		...(suggestions.length > 0 ? { suggestions } : {}),
	})
}

function invalidChoice(
	parameter: CompiledParameter,
	actual: string,
): CommandError<'ARGUMENT_SYNTAX'> {
	const allowedValues = parameter.choices!
	const suggestions = closestSuggestions(
		allowedValues.map((value) => ({ compare: actual, display: value })),
		{ normalize: (value) => value.toLowerCase() },
	)
	const preview = allowedValues.slice(0, 5).map((value) => JSON.stringify(value))
	const expected = `${preview.join(', ')}${allowedValues.length > preview.length ? ', …' : ''}`
	return syntaxError(`Expected one of ${expected} for "${parameter.name}"`, {
		reason: 'invalid_choice',
		parameter: parameter.name,
		allowedValues,
		...(suggestions.length > 0 ? { suggestions } : {}),
	})
}

function invalidValue(
	parameter: CompiledParameter,
	expected: 'number' | 'integer' | 'boolean',
): CommandError<'ARGUMENT_SYNTAX'> {
	return syntaxError(`Expected ${expected} for "${parameter.name}"`, {
		reason: `invalid_${expected}`,
		parameter: parameter.name,
	})
}

export function syntaxError(
	message: string,
	details: NonNullable<import('../types').CommandErrorDetails<'ARGUMENT_SYNTAX'>>,
	cause?: unknown,
): CommandError<'ARGUMENT_SYNTAX'> {
	return new CommandError('ARGUMENT_SYNTAX', 'Invalid command input', {
		message,
		details,
		...(cause !== undefined ? { cause } : {}),
	})
}
