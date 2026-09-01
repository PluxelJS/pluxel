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
	toolSetupId: string
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

export type CreatePiAgentSessionOptions = Readonly<{
	/** Stable caller-selected identity. A UUID is generated when omitted. */
	id?: string
	/** AgentTools assignment used as this session's complete command allowlist. */
	toolSetupId?: string
	model?: PiModelReference
	thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
	systemPrompt?: string
}>

export type PiAgentPromptOptions = Readonly<{
	signal?: AbortSignal
}>

export type PiSubagentOptions = Readonly<{
	/** Cancels queue admission and the child run without disposing the parent session. */
	signal?: AbortSignal
}>

export interface PiAgentSession {
	readonly id: string
	readonly toolSetupId: string
	snapshot(): PiAgentSessionSnapshot
	subscribe(listener: (event: PiAgentSessionEvent) => void): () => void
	prompt(text: string, options?: PiAgentPromptOptions): Promise<PiAgentRunResult>
	setGoal(text: string): void
	completeGoal(summary?: string): void
	clearGoal(): void
	spawnSubagent(task: string, options?: PiSubagentOptions): Promise<PiSubagentRunResult>
	abort(): Promise<void>
	dispose(): Promise<void>
}
