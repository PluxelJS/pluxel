import type { CliParseboxTailConfig, CliTailConfig } from '../../types'

type ParseboxLikeModule<Properties extends object> = {
	Parse(entry: keyof Properties, source: string): unknown
}

export const tail = {
	line(key: string, placeholder = '<text>'): CliTailConfig {
		return { mode: 'line', key, placeholder }
	},
	json(key: string, placeholder = '<json>'): CliTailConfig {
		return { mode: 'json', key, placeholder }
	},
	parsebox<Properties extends object, Entry extends keyof Properties>(
		module: ParseboxLikeModule<Properties>,
		entry: Entry,
		options?: { placeholder?: string; keys?: readonly string[] },
	): CliParseboxTailConfig {
		return {
			mode: 'parsebox',
			module: module as CliParseboxTailConfig['module'],
			entry: entry as PropertyKey,
			...(options?.placeholder ? { placeholder: options.placeholder } : {}),
			...(options?.keys ? { keys: options.keys } : {}),
		}
	},
} as const
