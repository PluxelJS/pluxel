import type { Static, TSchema } from '@sinclair/typebox'

export type Schema = TSchema
export type Infer<S extends Schema> = Static<S>

export type ValidationIssue = {
	path?: Array<string | number>
	message: string
	code?: string
	meta?: Record<string, unknown>
}

export const issue = (
	message: string,
	opts?: { path?: Array<string | number>; code?: string; meta?: Record<string, unknown> },
): ValidationIssue => ({
	message,
	...(opts?.path ? { path: opts.path } : {}),
	...(opts?.code ? { code: opts.code } : {}),
	...(opts?.meta ? { meta: opts.meta } : {}),
})

export const constraint = (
	path: string | number | Array<string | number>,
	message: string,
	opts?: { code?: string; meta?: Record<string, unknown> },
): ValidationIssue =>
	issue(message, {
		path: Array.isArray(path) ? path : [path],
		code: opts?.code ?? 'constraint',
		...(opts?.meta ? { meta: opts.meta } : {}),
	})

export type OpErrorCode =
	| 'E_OP_CONFIG'
	| 'E_OP_NOT_FOUND'
	| 'E_CLI_PARSE'
	| 'E_INPUT_VALIDATION'
	| 'E_OUTPUT_VALIDATION'
	| 'E_FORBIDDEN'
	| 'E_ABORTED'
	| 'E_TIMEOUT'
	| 'E_DEPENDENCY'
	| 'E_INTERNAL'

export type OpErrorKind = 'expected' | 'fault'

export type OpErrorDetailsByCode = {
	E_OP_CONFIG?: { id?: string; field?: string; reason?: string }
	E_OP_NOT_FOUND?: { id?: string; text?: string }
	E_CLI_PARSE?: {
		reason?: string
		param?: string
		suggestion?: string
		at?: { start?: number; end?: number; raw?: string }
	}
	E_INPUT_VALIDATION?: { issues: ValidationIssue[] }
	E_OUTPUT_VALIDATION?: { issues: ValidationIssue[] }
	E_FORBIDDEN?: { node?: string; reason?: string }
	E_ABORTED?: { reason?: unknown }
	E_TIMEOUT?: { now?: number; deadlineMs?: number }
	E_DEPENDENCY?: { service?: string; operation?: string; retryable?: boolean; causeCode?: string }
	E_INTERNAL?: Record<string, unknown>
}

export type OpErrorDetails<C extends OpErrorCode = OpErrorCode> =
	C extends keyof OpErrorDetailsByCode
		? NonNullable<OpErrorDetailsByCode[C]> | undefined
		: Record<string, unknown> | undefined

export class OpError<C extends OpErrorCode = OpErrorCode> extends Error {
	readonly code: C
	readonly kind: OpErrorKind
	readonly publicMessage: string
	readonly details?: OpErrorDetails<C>

	constructor(
		code: C,
		publicMessage: string,
		opts?: { message?: string; details?: OpErrorDetails<C>; cause?: unknown; kind?: OpErrorKind },
	) {
		super(
			opts?.message ?? publicMessage,
			opts?.cause !== undefined ? { cause: opts.cause } : undefined,
		)
		this.name = 'OpError'
		this.code = code
		this.kind = opts?.kind ?? kindOfOpErrorCode(code)
		this.publicMessage = publicMessage
		this.details = opts?.details
	}
}

export const kindOfOpErrorCode = (code: OpErrorCode): OpErrorKind => {
	if (code === 'E_INTERNAL' || code === 'E_DEPENDENCY') return 'fault'
	return 'expected'
}

export const toOpError = (
	error: unknown,
	fallbackCode: OpErrorCode,
	fallbackPublicMessage: string,
): OpError => {
	if (error instanceof OpError) return error
	const message = error instanceof Error ? error.message : fallbackPublicMessage
	return new OpError(fallbackCode, fallbackPublicMessage, { message, cause: error })
}

export interface OpContext {
	signal?: AbortSignal
	deadlineMs?: number
	now?: number
	emit?: (type: string, payload: Record<string, unknown>) => void
	span?: <T>(name: string, attrs: Record<string, unknown>, fn: () => T | Promise<T>) => Promise<T>
	classifyError?: (error: unknown) => OpError | undefined
	onFault?: (payload: {
		id: string
		err: OpError
		durationMs: number
		recovered: boolean
	}) => void | Promise<void>
	meta?: Record<string, unknown>
}

export type CustomValidator<T, Ctx extends OpContext = OpContext> = (
	value: T,
	ctx: Ctx,
) =>
	| void
	| ValidationIssue
	| ValidationIssue[]
	| Promise<void | ValidationIssue | ValidationIssue[]>

export type OpDoc = {
	title?: string
	description?: string
	details?: string
	usage?: string
	examples?: string[]
	tags?: string[]
}

export type OpExposure = {
	rpc?: boolean
	internal?: boolean
}

export type OpPolicy = {
	mutating?: boolean
	idempotent?: boolean
	confirm?: boolean
	audit?: string[]
}

export type ParamValueType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'json'

export type ParamSpec = {
	inputKey: string
	name: string
	aliases: string[]
	type: ParamValueType
	required: boolean
	description?: string
	itemType?: Exclude<ParamValueType, 'array'>
}

export type CliLineTailSpec =
	| {
			mode: 'line'
			key: string
			placeholder?: string
	  }
	| {
			mode: 'json'
			key: string
			placeholder?: string
	  }

export type CliParseboxTailSpec = {
	mode: 'parsebox'
	entry: string
	placeholder?: string
	keys?: readonly string[]
}

export type CliTailSpec = CliLineTailSpec | CliParseboxTailSpec

export type CliParseboxModule = {
	Parse(entry: PropertyKey, source: string): unknown
}

export type CliParseboxTailConfig = Omit<CliParseboxTailSpec, 'entry'> & {
	module: CliParseboxModule
	entry: PropertyKey
}

export type CliTailConfig = CliLineTailSpec | CliParseboxTailConfig

export type OpCliConfig = {
	triggers?: string[]
	tail?: CliTailConfig
}

export type OpToolConfig = {
	name?: string
}

export type ToolInputHint = {
	key: string
	type: ParamValueType
	required: boolean
	description?: string
}

export type ToolDef = {
	id: string
	name: string
	title: string
	description: string
	guidance: string
	details?: string
	usage?: string
	examples?: string[]
	tags?: string[]
	inputHints?: ToolInputHint[]
	inputSchema: Record<string, unknown>
	outputSchema: Record<string, unknown>
}

export type OpCliProjection = {
	triggers: string[]
	tail?: CliTailSpec
	usage?: string
}

export type OpTransports = {
	cli?: OpCliProjection
	tool?: ToolDef
}

export type OpSchemas = {
	input: Record<string, unknown>
	output: Record<string, unknown>
}

export type OpDescriptor = {
	id: string
	doc: OpDoc
	exposure: Required<OpExposure>
	policy: OpPolicy
	schemas: OpSchemas
	params?: ParamSpec[]
	transports: OpTransports
}

export type OpOk<T> = { ok: true; value: T }
export type OpErr = { ok: false; error: OpError }
export type OpResult<T> = OpOk<T> | OpErr

export type OperationConfig<I, O, Ctx extends OpContext = OpContext> = {
	id: string
	input: Schema
	output: Schema
	doc?: OpDoc
	exposure?: OpExposure
	policy?: OpPolicy
	cli?: false | true | OpCliConfig
	tool?: false | true | OpToolConfig
	validateInput?: Array<CustomValidator<I, Ctx>>
	validateOutput?: Array<CustomValidator<O, Ctx>>
	execute: (input: I, ctx: Ctx) => O | Promise<O>
}

export interface Operation<_I = unknown, O = unknown, Ctx extends OpContext = OpContext> {
	readonly id: string
	readonly descriptor: OpDescriptor
	run(candidate: unknown, ctx?: Ctx): Promise<O>
	runSafe(candidate: unknown, ctx?: Ctx): Promise<OpResult<O>>
}

export type AnyOperation<Ctx extends OpContext = OpContext> = Operation<any, any, Ctx>

export type OperationEntry = {
	owner?: string
	descriptor: OpDescriptor
}

export type OperationRegisterOptions = {
	owner?: string
}

export type OperationListOptions = {
	owner?: string
	carrier?: 'rpc' | 'tool' | 'cli'
	includeInternal?: boolean
}

export type ToolListOptions = {
	includeInternal?: boolean
}

export type OperationSpaceOptions = {
	caseInsensitive?: boolean
	maxTextLength?: number
}

export interface OperationSpace<Ctx extends OpContext = OpContext> {
	readonly version: number
	register(op: AnyOperation<Ctx>, opts?: OperationRegisterOptions): () => void
	unregister(id: string): void
	unregisterOwner(owner: string): number
	has(id: string): boolean
	get(id: string): AnyOperation<Ctx> | undefined
	getEntry(id: string): OperationEntry | undefined
	getDescriptor(id: string): OpDescriptor | undefined
	list(opts?: OperationListOptions): OpDescriptor[]
	listEntries(opts?: OperationListOptions): OperationEntry[]
	listTools(opts?: ToolListOptions): ToolDef[]
	invoke<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<O>
	invokeSafe<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<OpResult<O>>
	dispatch<O = unknown>(text: string, ctx?: Ctx): Promise<O>
	helpIndex(): CliHelpIndexResult
	helpCommand(name: string): CliHelpCommandResult | undefined
}

export type CliToken = {
	value: string
	raw: string
	start: number
	end: number
}

export type CliHelpIndexResult = {
	list: Array<{ id: string; trigger: string; title?: string; description?: string }>
}

export type CliHelpCommandResult = {
	id: string
	triggers: string[]
	title?: string
	description?: string
	details?: string
	examples?: string[]
	tags?: string[]
	params?: ParamSpec[]
	tail?: CliTailSpec
	usage?: string
}
