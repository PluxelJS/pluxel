import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type {
	AgentCommandCatalog,
	AgentCommandCatalogSnapshot,
	AgentToolsPlugin,
} from '@pluxel/agent-tools'
import type {
	AgentSession,
	AgentSessionEvent,
	ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { PiAgentPluginConfig } from './config.ts'
import type { PiEngine, ResolvedPiModel } from './engine.ts'
import { PiAgentError } from './errors.ts'
import { createPiToolDefinitions, requireGoalText, toPiAgentTools } from './tool-adapter.ts'
import type {
	CreatePiAgentSessionOptions,
	PiAgentPromptOptions,
	PiAgentRunResult,
	PiAgentSession,
	PiAgentSessionEvent,
	PiAgentSessionSnapshot,
	PiGoalSnapshot,
	PiModelReference,
	PiSubagentOptions,
	PiSubagentRunResult,
	PiSubagentSnapshot,
} from './types.ts'

const machineIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/

type SessionCreateInput = Readonly<{
	id: string
	toolSetupId: string
	parent?: ManagedPiSession
	depth: number
	model?: PiModelReference
	thinkingLevel: CreatePiAgentSessionOptions['thinkingLevel']
	systemPrompt: string
	cwd: string
	validateSetup: boolean
}>

type MutableSubagent = {
	id: string
	task: string
	status: PiSubagentSnapshot['status']
	startedAt?: string
	finishedAt?: string
	response?: string
	error?: string
}

export class PiAgentController {
	private active = true
	private config: PiAgentPluginConfig
	private readonly sessionsById = new Map<string, ManagedPiSession>()
	private readonly pendingCreates = new Set<Promise<unknown>>()
	private readonly listeners = new Set<() => void>()
	private readonly reservedSessionIds = new Set<string>()
	private readonly subagents: ConcurrencyGate
	private reservedSessions = 0

	constructor(
		private readonly agentTools: AgentToolsPlugin,
		private readonly engine: PiEngine,
		config: PiAgentPluginConfig,
		private readonly reportListenerError: (error: unknown) => void,
	) {
		this.config = config
		this.subagents = new ConcurrencyGate(config.maxConcurrentSubagents)
	}

	update(config: PiAgentPluginConfig): void {
		this.requireActive()
		this.config = config
		this.subagents.updateLimit(config.maxConcurrentSubagents)
		for (const session of this.sessionsById.values()) session.refreshTools()
		this.notify()
	}

	createSession(options: CreatePiAgentSessionOptions = {}): Promise<PiAgentSession> {
		this.requireActive()
		const id =
			options.id === undefined ? randomUUID() : normalizeMachineId(options.id, 'session id')
		const toolSetupId = normalizeMachineId(
			options.toolSetupId ?? this.config.defaultToolSetupId,
			'tool setup id',
		)
		const systemPrompt = normalizeText(
			options.systemPrompt ?? this.config.systemPrompt,
			'system prompt',
			32_000,
		)
		const model = normalizeModelReference(options.model ?? this.config.model)
		const task = this.createManaged({
			id,
			toolSetupId,
			depth: 0,
			model,
			thinkingLevel: options.thinkingLevel ?? this.config.thinkingLevel,
			systemPrompt,
			cwd: resolve(this.config.cwd),
			validateSetup: true,
		})
		return this.trackCreate(task)
	}

	sessions(): readonly PiAgentSessionSnapshot[] {
		return Object.freeze(
			[...this.sessionsById.values()]
				.filter((session) => session.depth === 0)
				.map((session) => session.snapshot()),
		)
	}

	session(id: string): PiAgentSession | undefined {
		return this.sessionsById.get(normalizeMachineId(id, 'session id'))
	}

	async disposeSession(id: string): Promise<void> {
		const session = this.sessionsById.get(id)
		if (!session) return
		await session.disposeOwned()
	}

	subscribe(listener: () => void): () => void {
		if (typeof listener !== 'function') throw new TypeError('Pi Agent listener must be a function')
		this.listeners.add(listener)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.listeners.delete(listener)
		}
	}

	async close(): Promise<void> {
		if (!this.active) return
		this.active = false
		this.subagents.close()
		const disposals = [...this.sessionsById.values()]
			.filter((session) => session.depth === 0)
			.map((session) => session.disposeOwned())
		await Promise.allSettled([...this.pendingCreates, ...disposals])
		this.listeners.clear()
	}

	currentConfig(): PiAgentPluginConfig {
		return this.config
	}

	emitChanged(): void {
		this.notify()
	}

	async runSubagent(
		owner: ManagedPiSession,
		taskInput: string,
		signal?: AbortSignal,
	): Promise<PiSubagentRunResult> {
		this.requireActive()
		owner.requireUsable()
		const task = normalizeText(taskInput, 'subagent task', 16_000)
		if (owner.depth >= this.config.maxSubagentDepth) {
			throw new PiAgentError('SUBAGENT_DEPTH', 'Subagent depth limit reached')
		}
		if (owner.subagentCount >= this.config.maxSubagentsPerSession) {
			throw new PiAgentError('SUBAGENT_LIMIT', 'Subagent limit reached for this session')
		}

		const id = randomUUID()
		const record: MutableSubagent = { id, task, status: 'queued' }
		owner.addSubagent(record)
		let release: (() => void) | undefined
		let child: ManagedPiSession | undefined
		try {
			release = await this.subagents.acquire(signal)
			if (signal?.aborted) throw new PiAgentError('ABORTED', 'Subagent run was aborted')
			record.status = 'running'
			record.startedAt = now()
			owner.changed()
			const parentModel = owner.modelReference()
			child = await this.trackCreate(
				this.createManaged({
					id,
					toolSetupId: owner.toolSetupId,
					parent: owner,
					depth: owner.depth + 1,
					model: parentModel ?? undefined,
					thinkingLevel: owner.thinkingLevel,
					systemPrompt: `${owner.systemPrompt}\n\nYou are a bounded subagent. Complete only the delegated task and report a concise result.`,
					cwd: owner.cwd,
					validateSetup: false,
				}),
			)
			child.setGoal(task)
			const abortChild = (): void => {
				void child?.abort()
			}
			signal?.addEventListener('abort', abortChild, { once: true })
			let result: PiAgentRunResult
			try {
				result = await child.prompt(task, { signal })
			} finally {
				signal?.removeEventListener('abort', abortChild)
			}
			record.finishedAt = now()
			if (result.ok === true) {
				record.status = 'completed'
				record.response = bounded(result.text, this.config.maxToolResultChars)
				return Object.freeze({ ok: true, id, text: record.response })
			}
			record.status = result.reason === 'aborted' ? 'aborted' : 'failed'
			record.error = result.message
			return Object.freeze({ ok: false, id, reason: result.reason, message: result.message })
		} catch (error) {
			record.finishedAt = now()
			record.status = signal?.aborted || isAbortError(error) ? 'aborted' : 'failed'
			record.error = publicErrorMessage(error)
			throw error
		} finally {
			if (child) await child.disposeOwned()
			release?.()
			owner.changed()
		}
	}

	remove(session: ManagedPiSession): void {
		if (this.sessionsById.get(session.id) !== session) return
		this.sessionsById.delete(session.id)
		session.parent?.removeChild(session)
		this.notify()
	}

	private async createManaged(input: SessionCreateInput): Promise<ManagedPiSession> {
		this.requireActive()
		if (this.sessionsById.has(input.id) || this.reservedSessionIds.has(input.id)) {
			throw new PiAgentError('INVALID_INPUT', 'Session id is already in use', {
				details: { sessionId: input.id },
			})
		}
		if (this.sessionsById.size + this.reservedSessions >= this.config.maxSessions) {
			throw new PiAgentError('SESSION_LIMIT', 'Pi Agent session limit reached')
		}
		if (
			input.validateSetup &&
			!this.agentTools.snapshot().assignments.some(({ agentId }) => agentId === input.toolSetupId)
		) {
			throw new PiAgentError(
				'TOOL_SETUP_NOT_FOUND',
				'Selected AgentTools assignment does not exist',
				{
					details: { toolSetupId: input.toolSetupId },
				},
			)
		}

		let model: ResolvedPiModel | undefined
		if (input.model) {
			model = this.engine.resolveModel(input.model)
			if (!model) {
				throw new PiAgentError('MODEL_NOT_FOUND', 'Selected Pi model is unavailable', {
					details: input.model,
				})
			}
		}

		this.reservedSessions += 1
		this.reservedSessionIds.add(input.id)
		const catalog = this.agentTools.catalog(input.toolSetupId)
		const session = new ManagedPiSession(this, catalog, input, this.reportListenerError)
		try {
			const upstream = await this.engine.createSession({
				cwd: input.cwd,
				systemPrompt: input.systemPrompt,
				thinkingLevel: input.thinkingLevel ?? this.config.thinkingLevel,
				...(model ? { model } : {}),
				tools: session.toolDefinitions(),
			})
			if (!this.active) {
				upstream.dispose()
				throw new PiAgentError('NOT_RUNNING', 'PiAgentPlugin is not running')
			}
			session.attach(upstream)
			this.sessionsById.set(session.id, session)
			input.parent?.addChild(session)
			this.notify()
			return session
		} catch (error) {
			await session.disposeDetached()
			throw error
		} finally {
			this.reservedSessions -= 1
			this.reservedSessionIds.delete(input.id)
		}
	}

	private trackCreate<T>(promise: Promise<T>): Promise<T> {
		this.pendingCreates.add(promise)
		void promise.then(
			() => this.pendingCreates.delete(promise),
			() => this.pendingCreates.delete(promise),
		)
		return promise
	}

	private requireActive(): void {
		if (!this.active) throw new PiAgentError('NOT_RUNNING', 'PiAgentPlugin is not running')
	}

	private notify(): void {
		for (const listener of new Set(this.listeners)) {
			try {
				listener()
			} catch (error) {
				this.reportListenerError(error)
			}
		}
	}
}

class ManagedPiSession implements PiAgentSession {
	readonly id: string
	readonly toolSetupId: string
	readonly depth: number
	readonly parent?: ManagedPiSession
	readonly thinkingLevel: CreatePiAgentSessionOptions['thinkingLevel']
	readonly systemPrompt: string
	readonly cwd: string
	private readonly createdAt = now()
	private readonly listeners = new Set<(event: PiAgentSessionEvent) => void>()
	private readonly children = new Set<ManagedPiSession>()
	private readonly subagentRecords: MutableSubagent[] = []
	private readonly lifetime = new AbortController()
	private catalogSnapshot: AgentCommandCatalogSnapshot
	private upstream?: AgentSession
	private unsubscribeUpstream?: () => void
	private unsubscribeCatalog: () => void
	private state: PiAgentSessionSnapshot['state'] = 'idle'
	private goalValue: PiGoalSnapshot | null = null
	private lastResponse?: string
	private disposePromise?: Promise<void>

	constructor(
		private readonly controller: PiAgentController,
		private readonly catalog: AgentCommandCatalog,
		input: SessionCreateInput,
		private readonly reportListenerError: (error: unknown) => void,
	) {
		this.id = input.id
		this.toolSetupId = input.toolSetupId
		this.parent = input.parent
		this.depth = input.depth
		this.thinkingLevel = input.thinkingLevel
		this.systemPrompt = input.systemPrompt
		this.cwd = input.cwd
		this.catalogSnapshot = catalog.snapshot()
		this.unsubscribeCatalog = catalog.subscribe((snapshot) => {
			this.catalogSnapshot = snapshot
			this.refreshTools()
			this.changed()
		})
	}

	get subagentCount(): number {
		return this.subagentRecords.length
	}

	attach(upstream: AgentSession): void {
		this.upstream = upstream
		this.unsubscribeUpstream = upstream.subscribe((event) => this.onUpstreamEvent(event))
		this.refreshTools()
	}

	toolDefinitions(): ToolDefinition[] {
		return createPiToolDefinitions({
			catalog: this.catalog,
			snapshot: this.catalogSnapshot,
			sessionId: this.id,
			maxResultChars: this.controller.currentConfig().maxToolResultChars,
			controls: {
				goal: (action, text, summary) => this.goal(action, text, summary),
				spawnSubagent: (task, signal) => this.spawnSubagentWithSignal(task, signal),
				canSpawnSubagent: () =>
					this.depth < this.controller.currentConfig().maxSubagentDepth &&
					this.controller.currentConfig().maxSubagentsPerSession > 0,
			},
		})
	}

	refreshTools(): void {
		if (!this.upstream || this.state === 'disposed') return
		this.upstream.agent.state.tools = toPiAgentTools(this.toolDefinitions())
	}

	snapshot(): PiAgentSessionSnapshot {
		const model = this.modelReference()
		return Object.freeze({
			id: this.id,
			...(this.parent ? { parentSessionId: this.parent.id } : {}),
			depth: this.depth,
			toolSetupId: this.toolSetupId,
			state: this.state,
			model,
			goal: this.goalValue ? Object.freeze({ ...this.goalValue }) : null,
			availableCommandNames: Object.freeze(
				this.catalogSnapshot.descriptors.map(({ name }) => name),
			),
			subagents: Object.freeze(this.subagentRecords.map((record) => Object.freeze({ ...record }))),
			...(this.lastResponse === undefined ? {} : { lastResponse: this.lastResponse }),
			createdAt: this.createdAt,
		})
	}

	subscribe(listener: (event: PiAgentSessionEvent) => void): () => void {
		if (typeof listener !== 'function')
			throw new TypeError('Pi Agent session listener must be a function')
		this.listeners.add(listener)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.listeners.delete(listener)
		}
	}

	async prompt(textInput: string, options: PiAgentPromptOptions = {}): Promise<PiAgentRunResult> {
		this.requireUsable()
		if (this.state !== 'idle') throw new PiAgentError('SESSION_BUSY', 'Pi Agent session is busy')
		const text = normalizeText(textInput, 'prompt', 100_000)
		if (options.signal?.aborted) {
			return Object.freeze({ ok: false, reason: 'aborted', message: 'Prompt was aborted' })
		}
		const upstream = this.requireUpstream()
		this.state = 'running'
		this.changed()
		const abort = (): void => {
			void this.abort()
		}
		options.signal?.addEventListener('abort', abort, { once: true })
		try {
			await upstream.prompt(text)
			const result = latestAssistantResult(upstream.messages)
			this.lastResponse = result.text
			if (result.reason === 'aborted') {
				return Object.freeze({ ok: false, reason: 'aborted', message: 'Prompt was aborted' })
			}
			if (result.reason === 'model_error') {
				return Object.freeze({ ok: false, reason: 'model_error', message: result.message })
			}
			return Object.freeze({ ok: true, text: result.text })
		} catch (error) {
			if (options.signal?.aborted || isAbortError(error)) {
				return Object.freeze({ ok: false, reason: 'aborted', message: 'Prompt was aborted' })
			}
			return Object.freeze({
				ok: false,
				reason: 'model_error',
				message: publicErrorMessage(error),
			})
		} finally {
			options.signal?.removeEventListener('abort', abort)
			if (!this.isDisposed()) this.state = 'idle'
			this.changed()
		}
	}

	setGoal(text: string): void {
		this.requireUsable()
		this.goalValue = Object.freeze({
			text: requireGoalText(text),
			status: 'active',
			updatedAt: now(),
		})
		this.changed()
	}

	completeGoal(summary?: string): void {
		this.requireUsable()
		if (!this.goalValue) throw new PiAgentError('INVALID_INPUT', 'No active goal exists')
		const normalizedSummary =
			summary === undefined ? undefined : normalizeText(summary, 'goal summary', 8_000)
		this.goalValue = Object.freeze({
			text: this.goalValue.text,
			status: 'completed',
			...(normalizedSummary ? { summary: normalizedSummary } : {}),
			updatedAt: now(),
		})
		this.changed()
	}

	clearGoal(): void {
		this.requireUsable()
		this.goalValue = null
		this.changed()
	}

	spawnSubagent(task: string, options: PiSubagentOptions = {}): Promise<PiSubagentRunResult> {
		const signal = options.signal
			? AbortSignal.any([this.lifetime.signal, options.signal])
			: this.lifetime.signal
		return this.controller.runSubagent(this, task, signal)
	}

	private spawnSubagentWithSignal(
		task: string,
		signal?: AbortSignal,
	): Promise<PiSubagentRunResult> {
		const composed = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
		return this.controller.runSubagent(this, task, composed)
	}

	async abort(): Promise<void> {
		if (this.state === 'disposed' || !this.upstream) return
		if (this.state === 'running') this.state = 'aborting'
		this.changed()
		await this.upstream.abort()
		await this.upstream.agent.waitForIdle()
		if (!this.isDisposed()) this.state = 'idle'
		this.changed()
	}

	dispose(): Promise<void> {
		return this.controller.disposeSession(this.id)
	}

	disposeOwned(): Promise<void> {
		if (this.disposePromise) return this.disposePromise
		this.disposePromise = this.disposeNow()
		return this.disposePromise
	}

	async disposeDetached(): Promise<void> {
		if (this.disposePromise) return this.disposePromise
		this.disposePromise = this.disposeNow()
		return this.disposePromise
	}

	addChild(child: ManagedPiSession): void {
		this.children.add(child)
	}

	removeChild(child: ManagedPiSession): void {
		this.children.delete(child)
	}

	addSubagent(record: MutableSubagent): void {
		this.subagentRecords.push(record)
		this.changed()
	}

	changed(): void {
		this.emit(Object.freeze({ type: 'snapshot', snapshot: this.snapshot() }))
		this.controller.emitChanged()
	}

	requireUsable(): void {
		if (this.state === 'disposed')
			throw new PiAgentError('NOT_RUNNING', 'Pi Agent session is disposed')
	}

	modelReference(): PiModelReference | null {
		const model = this.upstream?.model
		return model ? Object.freeze({ provider: model.provider, id: model.id }) : null
	}

	private async disposeNow(): Promise<void> {
		if (this.state === 'disposed') return
		this.state = 'disposed'
		this.changed()
		this.lifetime.abort()
		this.unsubscribeCatalog()
		this.unsubscribeUpstream?.()
		await Promise.allSettled([...this.children].map((child) => child.disposeOwned()))
		if (this.upstream) {
			try {
				await this.upstream.abort()
				await this.upstream.agent.waitForIdle()
			} finally {
				this.upstream.dispose()
			}
		}
		this.listeners.clear()
		this.controller.remove(this)
	}

	private goal(
		action: 'show' | 'set' | 'complete' | 'clear',
		text?: string,
		summary?: string,
	): PiGoalSnapshot | null {
		if (action === 'set') this.setGoal(requireGoalText(text))
		else if (action === 'complete') this.completeGoal(summary)
		else if (action === 'clear') this.clearGoal()
		return this.goalValue ? Object.freeze({ ...this.goalValue }) : null
	}

	private onUpstreamEvent(event: AgentSessionEvent): void {
		if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
			this.emit(Object.freeze({ type: 'text_delta', text: event.assistantMessageEvent.delta }))
		} else if (event.type === 'tool_execution_start') {
			this.emit(Object.freeze({ type: 'tool_start', name: event.toolName }))
		} else if (event.type === 'tool_execution_end') {
			this.emit(Object.freeze({ type: 'tool_end', name: event.toolName, isError: event.isError }))
		}
	}

	private emit(event: PiAgentSessionEvent): void {
		for (const listener of new Set(this.listeners)) {
			try {
				listener(event)
			} catch (error) {
				this.reportListenerError(error)
			}
		}
	}

	private requireUpstream(): AgentSession {
		if (!this.upstream) throw new PiAgentError('NOT_RUNNING', 'Pi Agent session is not ready')
		return this.upstream
	}

	private isDisposed(): boolean {
		return this.state === 'disposed'
	}
}

class ConcurrencyGate {
	private active = 0
	private closed = false
	private readonly queued: Array<{
		resolve: (release: () => void) => void
		reject: (error: unknown) => void
		signal?: AbortSignal
		onAbort?: () => void
	}> = []

	constructor(private limit: number) {}

	updateLimit(limit: number): void {
		this.limit = limit
		this.drain()
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.closed)
			return Promise.reject(new PiAgentError('NOT_RUNNING', 'PiAgentPlugin is stopping'))
		if (signal?.aborted)
			return Promise.reject(new PiAgentError('ABORTED', 'Subagent run was aborted'))
		return new Promise((grant, reject) => {
			const item: (typeof this.queued)[number] = {
				resolve: grant,
				reject,
				...(signal ? { signal } : {}),
			}
			if (signal) {
				item.onAbort = () => {
					const index = this.queued.indexOf(item)
					if (index >= 0) this.queued.splice(index, 1)
					reject(new PiAgentError('ABORTED', 'Subagent run was aborted'))
				}
				signal.addEventListener('abort', item.onAbort, { once: true })
			}
			this.queued.push(item)
			this.drain()
		})
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		for (const item of this.queued.splice(0)) {
			if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
			item.reject(new PiAgentError('NOT_RUNNING', 'PiAgentPlugin is stopping'))
		}
	}

	private drain(): void {
		while (!this.closed && this.active < this.limit && this.queued.length > 0) {
			const item = this.queued.shift()!
			if (item.signal && item.onAbort) item.signal.removeEventListener('abort', item.onAbort)
			if (item.signal?.aborted) {
				item.reject(new PiAgentError('ABORTED', 'Subagent run was aborted'))
				continue
			}
			this.active += 1
			let released = false
			item.resolve(() => {
				if (released) return
				released = true
				this.active -= 1
				this.drain()
			})
		}
	}
}

function latestAssistantResult(
	messages: readonly unknown[],
):
	| { reason: 'success'; text: string }
	| { reason: 'aborted'; text: string }
	| { reason: 'model_error'; text: string; message: string } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (
			!message ||
			typeof message !== 'object' ||
			(message as { role?: unknown }).role !== 'assistant'
		) {
			continue
		}
		const record = message as { content?: unknown; stopReason?: unknown; errorMessage?: unknown }
		const text = contentText(record.content)
		if (record.stopReason === 'aborted') return { reason: 'aborted', text }
		if (record.stopReason === 'error') {
			return {
				reason: 'model_error',
				text,
				message:
					typeof record.errorMessage === 'string'
						? record.errorMessage
						: 'The model request failed',
			}
		}
		return { reason: 'success', text }
	}
	return { reason: 'success', text: '' }
}

function contentText(content: unknown): string {
	if (typeof content === 'string') return content
	if (!Array.isArray(content)) return ''
	return content
		.filter(
			(block): block is { type: 'text'; text: string } =>
				!!block &&
				typeof block === 'object' &&
				(block as { type?: unknown }).type === 'text' &&
				typeof (block as { text?: unknown }).text === 'string',
		)
		.map(({ text }) => text)
		.join('')
}

function normalizeMachineId(value: string, label: string): string {
	const normalized = String(value).trim()
	if (!machineIdPattern.test(normalized)) {
		throw new PiAgentError('INVALID_INPUT', `${label} must be a stable 1–128 character machine id`)
	}
	return normalized
}

function normalizeText(value: string, label: string, maxLength: number): string {
	const normalized = String(value).trim()
	if (!normalized) throw new PiAgentError('INVALID_INPUT', `${label} is required`)
	if (normalized.length > maxLength) {
		throw new PiAgentError('INVALID_INPUT', `${label} exceeds ${maxLength} characters`)
	}
	return normalized
}

function normalizeModelReference(
	value: PiModelReference | undefined,
): PiModelReference | undefined {
	if (!value) return undefined
	return Object.freeze({
		provider: normalizeText(value.provider, 'model provider', 128),
		id: normalizeText(value.id, 'model id', 256),
	})
}

function publicErrorMessage(error: unknown): string {
	if (error instanceof PiAgentError) return error.publicMessage
	return error instanceof Error && error.message ? error.message : 'Pi Agent run failed'
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof PiAgentError && error.code === 'ABORTED') ||
		(error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)))
	)
}

function bounded(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n… result truncated`
}

function now(): string {
	return new Date().toISOString()
}
