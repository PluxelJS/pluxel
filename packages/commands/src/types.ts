import type { Result as BetterResult } from 'better-result'
import type { Static, StaticDecode, TObject, TSchema } from '@sinclair/typebox'

export type Schema = TSchema
/** Value seen by validators and the command implementation after local codecs run. */
export type Infer<S extends Schema> = StaticDecode<S>
/** JSON value accepted and returned by public command boundaries. */
export type Wire<S extends Schema> = Static<S>
export type ObjectSchema = TObject

export type ValidationIssue = {
	/** Path segments from the command root to the invalid value. Omitted for command-wide issues. */
	path?: Array<string | number>
	message: string
	/** Stable author-defined code when callers need to branch without parsing `message`. */
	code?: string
	/** Optional diagnostic facts. Carriers decide whether they are safe to expose. */
	meta?: Record<string, unknown>
}

export function issue(
	message: string,
	options?: {
		path?: Array<string | number>
		code?: string
		meta?: Record<string, unknown>
	},
): ValidationIssue {
	return {
		message,
		...(options?.path ? { path: options.path } : {}),
		...(options?.code ? { code: options.code } : {}),
		...(options?.meta ? { meta: options.meta } : {}),
	}
}

export function constraint(
	path: string | number | Array<string | number>,
	message: string,
	options?: { code?: string; meta?: Record<string, unknown> },
): ValidationIssue {
	return issue(message, {
		path: Array.isArray(path) ? path : [path],
		code: options?.code ?? 'constraint',
		...(options?.meta ? { meta: options.meta } : {}),
	})
}

export type CommandErrorCode =
	| 'COMMAND_CONFIG'
	| 'COMMAND_NOT_FOUND'
	| 'ARGUMENT_SYNTAX'
	| 'INPUT_VALIDATION'
	| 'FORBIDDEN'
	| 'ABORTED'
	| 'TIMEOUT'
	| 'DEPENDENCY'
	| 'INTERNAL'

export type CommandErrorKind = 'expected' | 'fault'

export type ArgumentSyntaxReason =
	| 'input_too_long'
	| 'dangling_escape'
	| 'unterminated_quote'
	| 'duplicate_parameter'
	| 'missing_value'
	| 'unexpected_positional'
	| 'unknown_parameter'
	| 'invalid_number'
	| 'invalid_integer'
	| 'invalid_boolean'
	| 'invalid_choice'
	| 'invalid_json'

type CommandErrorDetailsByCode = {
	COMMAND_CONFIG?: {
		command?: string
		field?: string
		reason?: string
		/** Schema location for configuration failures that apply below a top-level field. */
		path?: Array<string | number>
	}
	COMMAND_NOT_FOUND?: { name?: string; input?: string; suggestions?: readonly string[] }
	ARGUMENT_SYNTAX?: {
		reason?: ArgumentSyntaxReason
		parameter?: string
		at?: { start?: number; end?: number; raw?: string }
		/** Canonical argv spellings that are close to the rejected input. */
		suggestions?: readonly string[]
		/** Closed string values accepted by the parameter. */
		allowedValues?: readonly string[]
	}
	INPUT_VALIDATION?: { issues: ValidationIssue[] }
	FORBIDDEN?: { permission?: string; reason?: string }
	ABORTED?: undefined
	TIMEOUT?: { now?: number; deadlineMs?: number }
	DEPENDENCY?: { service?: string; command?: string; retryable?: boolean; causeCode?: string }
	INTERNAL?: Record<string, unknown>
}

export type CommandErrorDetails<C extends CommandErrorCode = CommandErrorCode> =
	C extends keyof CommandErrorDetailsByCode
		? NonNullable<CommandErrorDetailsByCode[C]> | undefined
		: Record<string, unknown> | undefined

function kindOfCommandError(code: CommandErrorCode): CommandErrorKind {
	return code === 'COMMAND_CONFIG' || code === 'DEPENDENCY' || code === 'INTERNAL'
		? 'fault'
		: 'expected'
}

export class CommandError<C extends CommandErrorCode = CommandErrorCode> extends Error {
	readonly code: C
	readonly kind: CommandErrorKind
	readonly publicMessage: string
	readonly details?: CommandErrorDetails<C>

	constructor(
		code: C,
		publicMessage: string,
		options?: {
			message?: string
			details?: CommandErrorDetails<C>
			cause?: unknown
		},
	) {
		super(
			options?.message ?? publicMessage,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		)
		this.name = 'CommandError'
		this.code = code
		this.kind = kindOfCommandError(code)
		this.publicMessage = publicMessage
		this.details = options?.details
	}
}

export function toCommandError(
	error: unknown,
	fallbackCode: CommandErrorCode,
	fallbackPublicMessage: string,
): CommandError {
	if (error instanceof CommandError) return error
	return new CommandError(fallbackCode, fallbackPublicMessage, {
		message: error instanceof Error ? error.message : fallbackPublicMessage,
		cause: error,
	})
}

/**
 * Per-invocation data record passed through command carriers.
 *
 * Context extensions should use enumerable own data properties; carrier runtimes may copy the
 * record to replace `signal` with a host-composed signal before execution.
 */
export interface CommandContext {
	readonly signal?: AbortSignal
	/** Absolute Unix timestamp. */
	readonly deadlineMs?: number
	readonly meta?: Readonly<Record<string, unknown>>
}

export type CommandContextArgs<Ctx extends CommandContext> = CommandContext extends Ctx
	? [context?: Ctx]
	: [context: Ctx]

export type CommandFailure = {
	readonly message: string
	readonly cause?: unknown
} & (
	| {
			readonly code: 'INPUT_VALIDATION'
			readonly issues: readonly {
				readonly path?: readonly (string | number)[]
				readonly code?: string
				readonly message: string
			}[]
	  }
	| { readonly code: 'REJECTED'; readonly reason: string }
	| {
			readonly code:
				| 'FORBIDDEN'
				| 'COMMAND_NOT_FOUND'
				| 'PUBLICATION_GONE'
				| 'ABORTED'
				| 'TIMEOUT'
				| 'DEPENDENCY'
				| 'INTERNAL'
				| 'OUTPUT_ENCODING'
				| 'OUTPUT_LIMIT'
	  }
)

export type CommandDescriptor = {
	readonly name: string
	readonly description: string
	readonly inputSchema: Readonly<Record<string, unknown>>
}

export type DefineCommandConfig<
	SIn extends ObjectSchema,
	O,
	Ctx extends CommandContext = CommandContext,
> = {
	readonly name: string
	readonly description: string
	readonly input: SIn
	readonly execute: (
		input: Infer<SIn>,
		context: Ctx,
	) => BetterResult<O, CommandFailure> | Promise<BetterResult<O, CommandFailure>>
}

declare const commandInputType: unique symbol

export interface Command<I = unknown, O = unknown, Ctx extends CommandContext = CommandContext> {
	readonly name: string
	readonly descriptor: CommandDescriptor
	/** @internal Keeps input invariant for argv bindings. */
	readonly [commandInputType]?: (input: I) => I
	readonly execute: (
		candidate: I,
		...context: CommandContextArgs<Ctx>
	) => Promise<BetterResult<O, CommandFailure>>
}

export type DirectCommand<
	I = unknown,
	O = unknown,
	Ctx extends CommandContext = CommandContext,
> = Command<I, O, Ctx> & {
	readonly dispose?: never
	readonly mounted?: never
}
export type AnyCommand<Ctx extends CommandContext = CommandContext> = Command<any, unknown, Ctx>
export type Registration = {
	readonly name: string
	readonly dispose: () => void
	readonly [Symbol.dispose]: () => void
}
export type CommandRegistration<
	I = unknown,
	O = unknown,
	Ctx extends CommandContext = CommandContext,
> = Command<I, O, Ctx> & Registration
