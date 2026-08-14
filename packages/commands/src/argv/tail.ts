import type { ArgvStringField, ArgvTailConfig } from './types'

export const tail = {
	/** Assign the remaining source to one string-backed Command input field. */
	text<Input>(key: ArgvStringField<Input>, placeholder = '<text>'): ArgvTailConfig<Input> {
		return { mode: 'text', key, placeholder }
	},
	/** Parse the remaining source as one JSON value for a Command input field. */
	json<Input>(key: keyof Input & string, placeholder = '<json>'): ArgvTailConfig<Input> {
		return { mode: 'json', key, placeholder }
	},
} as const
