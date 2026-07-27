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
	| 'OUTPUT_VALIDATION'
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
	OUTPUT_VALIDATION?: { issues: ValidationIssue[] }
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
	return code === 'COMMAND_CONFIG' ||
		code === 'OUTPUT_VALIDATION' ||
		code === 'DEPENDENCY' ||
		code === 'INTERNAL'
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

export interface CommandContext {
	/** Cooperative cancellation signal. Omitted when the call has no cancellation source. */
	readonly signal?: AbortSignal
	/** Absolute Unix timestamp checked before and after execution. */
	readonly deadlineMs?: number
	/** Host-owned request metadata. Omitted when the carrier has no metadata to pass. */
	readonly meta?: Readonly<Record<string, unknown>>
}

/** Context may be omitted only when the command does not require host-specific fields. */
export type CommandContextArgs<Ctx extends CommandContext> = CommandContext extends Ctx
	? [context?: Ctx]
	: [context: Ctx]

export type Validator<T, Ctx extends CommandContext = CommandContext> = (
	value: T,
	context: Ctx,
) =>
	| void
	| ValidationIssue
	| ValidationIssue[]
	| Promise<void | ValidationIssue | ValidationIssue[]>

/** Static worst-case behavior for tool discovery, confirmation, and audit policy. */
export type CommandBehavior =
	| {
			readonly kind: 'query'
			readonly world: 'closed' | 'open'
	  }
	| {
			readonly kind: 'mutation'
			readonly destructive: boolean
			readonly idempotent: boolean
			readonly world: 'closed' | 'open'
	  }

/** Transport-neutral example. Carrier syntax such as argv quoting does not belong here. */
export type CommandExample<I = unknown, O = unknown> = {
	readonly title?: string
	readonly input: I
	readonly output?: O
}

export type CommandDescriptor = {
	readonly name: string
	readonly title?: string
	readonly description: string
	readonly behavior: CommandBehavior
	readonly inputSchema: Readonly<Record<string, unknown>>
	readonly outputSchema?: Readonly<Record<string, unknown>>
	readonly examples?: readonly CommandExample[]
}

export type CommandOk<T> = { ok: true; value: T }
export type CommandErr = { ok: false; error: CommandError }
export type CommandResult<T> = CommandOk<T> | CommandErr

type CommandDefinitionBase<
	SIn extends ObjectSchema,
	Ctx extends CommandContext = CommandContext,
> = {
	name: string
	/** Short presentation label. Omitted when the machine name is sufficient. */
	title?: string
	description: string
	behavior: CommandBehavior
	input: SIn
	/** Cross-field or context-aware validation after schema decoding. */
	validate?: Validator<Infer<SIn>, Ctx>
}

export type OutputCommandDefinition<
	SIn extends ObjectSchema,
	SOut extends ObjectSchema,
	Ctx extends CommandContext = CommandContext,
> = CommandDefinitionBase<SIn, Ctx> & {
	output: SOut
	/** Transport-neutral wire examples. Omitted when the schema is self-explanatory. */
	examples?: readonly CommandExample<Wire<SIn>, Wire<SOut>>[]
	/** Domain validation after output encoding and wire validation. */
	validateOutput?: Validator<Infer<SOut>, Ctx>
	execute(input: Infer<SIn>, context: Ctx): Infer<SOut> | Promise<Infer<SOut>>
}

export type VoidCommandDefinition<
	SIn extends ObjectSchema,
	Ctx extends CommandContext = CommandContext,
> = CommandDefinitionBase<SIn, Ctx> & {
	/** Omit output when success has no business value. */
	output?: never
	/** Transport-neutral input examples. */
	examples?: readonly CommandExample<Wire<SIn>, never>[]
	validateOutput?: never
	execute(input: Infer<SIn>, context: Ctx): void | Promise<void>
}

export type DefineCommandConfig<
	SIn extends ObjectSchema,
	SOut extends ObjectSchema | undefined = undefined,
	Ctx extends CommandContext = CommandContext,
> = SOut extends ObjectSchema
	? OutputCommandDefinition<SIn, SOut, Ctx>
	: VoidCommandDefinition<SIn, Ctx>

export interface Command<_I = unknown, O = unknown, Ctx extends CommandContext = CommandContext> {
	readonly name: string
	readonly descriptor: CommandDescriptor
	execute(candidate: unknown, ...context: CommandContextArgs<Ctx>): Promise<CommandResult<O>>
	executeOrThrow(candidate: unknown, ...context: CommandContextArgs<Ctx>): Promise<O>
}

export type AnyCommand<Ctx extends CommandContext = CommandContext> = Command<any, any, Ctx>

export type Registration = {
	readonly name: string
	dispose(): void
}
