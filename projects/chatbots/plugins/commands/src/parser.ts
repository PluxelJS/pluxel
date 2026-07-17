import { ChatCommandError, type ParsedCommandLine } from './types.ts'

export function normalizeRoute(route: string): string {
	const value = route.trim().toLowerCase().replaceAll(/\s+/g, ' ')
	if (!value || !value.split(' ').every((part) => /^[a-z0-9][a-z0-9_-]*$/.test(part)))
		throw new Error(`Invalid command route: ${route}`)
	return value
}

export function tokenizeCommand(input: string): string[] {
	return scanCommand(input).map((item) => item.value)
}

function scanCommand(input: string): Array<{ value: string; start: number; end: number }> {
	const tokens: string[] = []
	const spans: Array<{ start: number; end: number }> = []
	let token = ''
	let quote = ''
	let escaped = false
	let active = false
	let start = 0
	for (let index = 0; index < input.length; index++) {
		const char = input[index]!
		if (!active && !/\s/.test(char)) start = index
		if (escaped) {
			token += char
			escaped = false
			active = true
			continue
		}
		if (char === '\\') {
			escaped = true
			active = true
			continue
		}
		if (quote) {
			if (char === quote) quote = ''
			else token += char
			active = true
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			active = true
			continue
		}
		if (/\s/.test(char)) {
			if (active) {
				tokens.push(token)
				spans.push({ start, end: index })
				token = ''
				active = false
			}
			continue
		}
		token += char
		active = true
	}
	if (quote) throw new ChatCommandError('PARSE', '命令参数存在未闭合的引号。')
	if (escaped) token += '\\'
	if (active || token) {
		tokens.push(token)
		spans.push({ start, end: input.length })
	}
	return tokens.map((value, index) => Object.assign({ value }, spans[index]!))
}

export function parseCommandLine(input: string): ParsedCommandLine {
	const scanned = scanCommand(input)
	const tokens = scanned.map((item) => item.value)
	const positionals: string[] = []
	const values = new Map<string, Array<string | boolean>>()
	let flagsEnabled = true
	const add = (key: string, value: string | boolean) => {
		const bucket = values.get(key) ?? []
		bucket.push(value)
		values.set(key, bucket)
	}
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!
		if (flagsEnabled && token === '--') {
			flagsEnabled = false
			continue
		}
		if (flagsEnabled && token.startsWith('--') && token.length > 2) {
			const equal = token.indexOf('=')
			const key = token.slice(2, equal < 0 ? undefined : equal)
			if (!/^[a-z0-9][a-z0-9_-]*$/i.test(key))
				throw new ChatCommandError('PARSE', `无效参数：${token}`)
			if (equal >= 0) add(key, token.slice(equal + 1))
			else if (tokens[index + 1] && !tokens[index + 1]!.startsWith('-')) add(key, tokens[++index]!)
			else add(key, true)
			continue
		}
		if (flagsEnabled && /^-[a-z]+$/i.test(token)) {
			for (const key of token.slice(1)) add(key, true)
			continue
		}
		positionals.push(token)
	}
	const flags: Record<string, string | boolean | readonly string[]> = {}
	for (const [key, bucket] of values)
		flags[key] = bucket.length === 1 ? bucket[0]! : bucket.map(String)
	return {
		tokens,
		tokenSpans: scanned.map(({ start, end }) => ({ start, end })),
		positionals,
		flags,
	}
}
