import type { Runtime } from '@sinclair/parsebox'
import type { CliParseboxTailConfig, CliTailConfig } from '../../types'

export const tail = {
	line(key: string, placeholder = '<text>'): CliTailConfig {
		return { mode: 'line', key, placeholder }
	},
	json(key: string, placeholder = '<json>'): CliTailConfig {
		return { mode: 'json', key, placeholder }
	},
	parsebox<Properties extends Runtime.IProperties, Entry extends keyof Properties>(
		module: Runtime.Module<Properties>,
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
