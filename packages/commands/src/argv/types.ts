import type { Command, CommandContext } from '../types'

/** Raw command text or argv tokens already split by a shell/runtime. */
export type ArgvInput = string | readonly string[]

export type ArgvToken = {
	value: string
	raw: string
	start: number
	end: number
}

export type ArgvValueType = 'string' | 'number' | 'integer' | 'boolean' | 'json'

export type ArgvOptionBinding = {
	/** Long option name without `--`. Defaults to the kebab-cased input key. */
	name?: string
	/** Extra long or one-character short names, without leading dashes. */
	aliases?: readonly string[]
	description?: string
	/** Complex schemas must opt into JSON decoding instead of being guessed. */
	format?: 'json'
}

/** One input-object field that consumes one argv token in positional order. */
export type ArgvPositionalBinding<Input> =
	| (keyof Input & string)
	| {
			key: keyof Input & string
			name?: string
			format?: 'json'
	  }

export type ArgvStringField<Input> = {
	[Key in keyof Input & string]-?: Exclude<Input[Key], undefined> extends string ? Key : never
}[keyof Input & string]

export type ArgvTailConfig<Input> =
	| {
			/** Assign all remaining source to one string wire field without interpreting it. */
			mode: 'text'
			key: ArgvStringField<Input>
			placeholder?: string
	  }
	| {
			/** Parse all remaining source as one JSON value for the selected field. */
			mode: 'json'
			key: keyof Input & string
			placeholder?: string
	  }

/** Carrier syntax over existing Command input fields, not a second input schema. */
export type ArgvBinding<Input> = {
	/** Complete token routes. The first route is canonical; the rest are aliases. */
	routes: readonly string[]
	/** Overrides for schema fields exposed as options. Unlisted scalar fields use generated options. */
	options?: Partial<Record<keyof Input & string, ArgvOptionBinding>>
	/** One-token positional order. Options may interleave until tail consumption begins. */
	positionals?: readonly ArgvPositionalBinding<Input>[]
	/** One field that consumes the remaining source and ends structural argv parsing. */
	tail?: ArgvTailConfig<Input>
}

export type ArgvRouterOptions = {
	/** Whether route matching ignores case. @defaultValue true */
	caseInsensitive?: boolean
	/** Maximum accepted command text length in UTF-16 code units. @defaultValue 16384 */
	maxTextLength?: number
}

export type ArgvParameterDescriptor = {
	readonly key: string
	readonly kind: 'option' | 'positional'
	readonly name: string
	/** Explicit extra names, excluding the primary `name`. */
	readonly aliases: readonly string[]
	readonly type: ArgvValueType | 'array'
	readonly itemType?: ArgvValueType
	readonly required: boolean
	readonly description?: string
	/** Closed string values accepted by this parameter, when its schema declares them. */
	readonly choices?: readonly string[]
	/** Strict JSON default declared by the field schema. */
	readonly defaultValue?: unknown
}

export type ArgvCommandDescriptor = {
	readonly name: string
	readonly routes: readonly string[]
	readonly title: string
	readonly description: string
	readonly usage: string
	readonly parameters: readonly ArgvParameterDescriptor[]
	readonly tail?: { readonly mode: 'text' | 'json'; readonly placeholder: string }
}

export type ArgvResolution<Ctx extends CommandContext = CommandContext, Output = unknown> = {
	command: Command<any, Output, Ctx>
	route: string
	candidate: Record<string, unknown>
}
