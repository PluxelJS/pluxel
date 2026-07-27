import type { ArgvStringField, ArgvTailConfig } from './types'

export const tail = {
	text<Input>(key: ArgvStringField<Input>, placeholder = '<text>'): ArgvTailConfig<Input> {
		return { mode: 'text', key, placeholder }
	},
	json<Input>(key: keyof Input & string, placeholder = '<json>'): ArgvTailConfig<Input> {
		return { mode: 'json', key, placeholder }
	},
} as const
