import type { Runtime } from '@sinclair/parsebox'
import type { CliTailSpec } from '../../types'

export const tail = {
	line(key: string, placeholder = '<text>'): CliTailSpec {
		return { mode: 'line', key, placeholder }
	},
	json(key: string, placeholder = '<json>'): CliTailSpec {
		return { mode: 'json', key, placeholder }
	},
	parsebox<Properties extends Runtime.IProperties, Entry extends keyof Properties>(
		module: Runtime.Module<Properties>,
		entry: Entry,
		options?: { placeholder?: string; keys?: readonly string[] },
	): CliTailSpec {
		return {
			mode: 'parsebox',
			module: module as Runtime.Module<Runtime.IProperties>,
			entry: entry as keyof Runtime.IProperties,
			...(options?.placeholder ? { placeholder: options.placeholder } : {}),
			...(options?.keys ? { keys: options.keys } : {}),
		}
	},
} as const
