import type {
	CommandContext,
	DirectCommand,
	CommandDescriptor,
	Registration,
} from '@pluxel/commands'

export type PiModelReference = Readonly<{
	provider: string
	id: string
}>

export type PiGoalSnapshot = Readonly<{
	text: string
	status: 'active' | 'completed'
	summary?: string
	updatedAt: string
}>

export type PiSubagentSnapshot = Readonly<{
	id: string
	task: string
	status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted'
	startedAt?: string
	finishedAt?: string
	response?: string
	error?: string
}>

export type PiAgentSessionState = 'idle' | 'running' | 'aborting' | 'disposed'

export type PiAgentSessionSnapshot = Readonly<{
	id: string
	parentSessionId?: string
	depth: number
	state: PiAgentSessionState
	model: PiModelReference | null
	goal: PiGoalSnapshot | null
	availableCommandNames: readonly string[]
	subagents: readonly PiSubagentSnapshot[]
	lastResponse?: string
	createdAt: string
}>

export type PiAgentSessionEvent =
	| Readonly<{ type: 'snapshot'; snapshot: PiAgentSessionSnapshot }>
	| Readonly<{ type: 'text_delta'; text: string }>
	| Readonly<{ type: 'tool_start'; name: string }>
	| Readonly<{ type: 'tool_end'; name: string; isError: boolean }>

export type PiAgentRunResult =
	| Readonly<{ ok: true; text: string }>
	| Readonly<{ ok: false; reason: 'aborted' | 'model_error'; message: string }>

export type PiSubagentRunResult =
	| Readonly<{ ok: true; id: string; text: string }>
	| Readonly<{ ok: false; id: string; reason: 'aborted' | 'model_error'; message: string }>

export type PiToolChoice =
	| string
	| Readonly<{
			name: string
			descriptor: CommandDescriptor
			execute: (...args: any[]) => unknown
			dispose?: never
	  }>
export type PiAuthorization = (
	input: Readonly<{ name: string; principal: unknown; signal: AbortSignal }>,
) => boolean | Promise<boolean>
export type PiBusinessContext<Ctx extends CommandContext> = Omit<Ctx, keyof CommandContext> & {
	readonly signal?: never
	readonly deadlineMs?: never
	readonly meta?: never
}
export type PiContextFactory<Ctx extends CommandContext> = (
	input: Readonly<{ principal: unknown; signal: AbortSignal; deadlineMs?: number }>,
) => PiBusinessContext<Ctx> | Promise<PiBusinessContext<Ctx>>
export type PiExposureOptions<Ctx extends CommandContext> = Readonly<{
	authorize?: PiAuthorization
}> &
	(CommandContext extends Ctx
		? { readonly context?: PiContextFactory<Ctx> }
		: { readonly context: PiContextFactory<Ctx> })
export type PiToolDescriptor = Readonly<{
	name: string
	descriptor: CommandDescriptor
}>
export type PiToolExposure = Registration

type DirectContext<T> =
	T extends DirectCommand<infer _I, infer _O, infer Ctx> ? Ctx : CommandContext
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
	value: infer I,
) => void
	? I
	: never
type SessionContext<Tools extends readonly PiToolChoice[]> = UnionToIntersection<
	DirectContext<Tools[number]>
>
type SessionContextOption<Tools extends readonly PiToolChoice[]> =
	Extract<Tools[number], { readonly execute: (...args: any[]) => unknown }> extends never
		? { readonly context?: never }
		: CommandContext extends SessionContext<Tools>
			? { readonly context?: PiBusinessContext<SessionContext<Tools>> }
			: { readonly context: PiBusinessContext<SessionContext<Tools>> }

type SessionOptionsBase<Tools extends readonly PiToolChoice[] = readonly PiToolChoice[]> =
	Readonly<{
		id?: string
		tools?: Tools
		authorize?: PiAuthorization
		model?: PiModelReference
		thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
		systemPrompt?: string
	}> &
		SessionContextOption<NoInfer<Tools>>

export type CreatePiAgentSessionOptions<
	Tools extends readonly PiToolChoice[] = readonly PiToolChoice[],
> = SessionOptionsBase<Tools> & Readonly<{ principal?: unknown }>

export type PiAgentPromptOptions = Readonly<{
	signal?: AbortSignal
}>

export type PiSubagentOptions = Readonly<{
	/** Cancels queue admission and the child run without disposing the parent session. */
	signal?: AbortSignal
}>

export interface PiAgentSession {
	readonly id: string
	snapshot(): PiAgentSessionSnapshot
	subscribe(listener: (event: PiAgentSessionEvent) => void): () => void
	prompt(text: string, options?: PiAgentPromptOptions): Promise<PiAgentRunResult>
	setGoal(text: string): void
	completeGoal(summary?: string): void
	clearGoal(): void
	spawnSubagent(task: string, options?: PiSubagentOptions): Promise<PiSubagentRunResult>
	abort(): Promise<void>
	dispose(): Promise<void>
	[Symbol.asyncDispose](): Promise<void>
}
