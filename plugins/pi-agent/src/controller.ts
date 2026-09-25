import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
	Result,
	type CommandContext,
	type DirectCommand,
	type CommandFailure,
} from '@pluxel/commands'
import type { Context as CoreContext } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/internal'
import type {
	AgentSession,
	AgentSessionEvent,
	ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { PiAgentPluginConfig } from './config.ts'
import type { PiEngine, ResolvedPiModel } from './engine.ts'
import { PiAgentError } from './errors.ts'
import {
	createPiToolDefinitions,
	requireGoalText,
	toPiAgentTools,
	type PiToolDelivery,
	type SelectedPiCommand,
} from './tool-adapter.ts'
import type {
	CreatePiAgentSessionOptions,
	PiExposureOptions,
	PiAuthorization,
	PiToolChoice,
	PiToolDescriptor,
	PiToolExposure,
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
	tools: readonly SelectedPiCommand[]
	principal: unknown
	owner: CoreContext
	context?: CommandContext
	authorize?: PiAuthorization
	parent?: ManagedPiSession
	depth: number
	model?: PiModelReference
	thinkingLevel: CreatePiAgentSessionOptions['thinkingLevel']
	systemPrompt: string
	cwd: string
}>

type ExposureRecord = {
	readonly name: string
	readonly command: DirectCommand<any, unknown, any>
	readonly owner: CoreContext
	readonly options: PiExposureOptions<any>
	active: boolean
	guard?: { cancel(): void }
}

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
	private closePromise?: Promise<void>
	private config: PiAgentPluginConfig
	private readonly exposures = new Map<string, ExposureRecord>()
	private readonly sessionsById = new Map<string, ManagedPiSession>()
	private readonly pendingCreates = new Set<Promise<unknown>>()
	private readonly listeners = new Set<() => void>()
	private readonly reservedSessionIds = new Set<string>()
	private readonly subagents: ConcurrencyGate
	private reservedSessions = 0

	constructor(
		private readonly providerOwner: CoreContext,
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
		this.notify()
	}

	createSession<const Tools extends readonly PiToolChoice[]>(
		options: CreatePiAgentSessionOptions<Tools>,
		owner?: CoreContext,
	): Promise<PiAgentSession>
	createSession(
		options?: CreatePiAgentSessionOptions<readonly []>,
		owner?: CoreContext,
	): Promise<PiAgentSession>
	async createSession(
		options: CreatePiAgentSessionOptions = {},
		owner: CoreContext = this.providerOwner,
	): Promise<PiAgentSession> {
		this.requireActive()
		const id =
			options.id === undefined ? randomUUID() : normalizeMachineId(options.id, 'session id')
		const systemPrompt = normalizeText(
			options.systemPrompt ?? this.config.systemPrompt,
			'system prompt',
			32_000,
		)
		const model = normalizeModelReference(options.model ?? this.config.model)
		const principal = options.principal
		const selected = this.resolveTools({ ...options, principal }, owner)
		const task = this.createManaged({
			id,
			tools: selected,
			owner,
			principal,
			...(options.context ? { context: options.context } : {}),
			...(options.authorize ? { authorize: options.authorize } : {}),
			depth: 0,
			model,
			thinkingLevel: options.thinkingLevel ?? this.config.thinkingLevel,
			systemPrompt,
			cwd: resolve(this.config.cwd),
		})
		return await this.trackCreate(task)
	}

	expose<I, O, Ctx extends CommandContext>(
		owner: CoreContext,
		command: DirectCommand<I, O, Ctx>,
		options: PiExposureOptions<Ctx>,
	): PiToolExposure {
		this.requireActive()
		if (owner.root !== this.providerOwner.root)
			throw new TypeError('Pi exposure cannot cross runtime roots')
		if (
			typeof command?.name !== 'string' ||
			command.name !== command.descriptor?.name ||
			typeof command.execute !== 'function' ||
			'dispose' in command
		) {
			throw new PiAgentError('INVALID_INPUT', 'Pi exposure requires a direct Command')
		}
		if (this.exposures.has(command.name))
			throw new PiAgentError('TOOL_CONFLICT', `Tool "${command.name}" is already exposed`)
		if (options.context !== undefined && typeof options.context !== 'function')
			throw new PiAgentError('INVALID_INPUT', 'Exposure context must be a function')
		const record: ExposureRecord = {
			name: command.name,
			command: command as DirectCommand<any, unknown, any>,
			owner,
			options,
			active: true,
		}
		const dispose = () => {
			if (!record.active) return
			record.active = false
			record.guard?.cancel()
			if (this.exposures.get(record.name) === record) this.exposures.delete(record.name)
		}
		record.guard = owner.effects.defer(dispose, { tag: `PiTool:${record.name}` })
		this.exposures.set(record.name, record)
		return Object.freeze({ name: record.name, dispose, [Symbol.dispose]: dispose })
	}

	tools(): readonly PiToolDescriptor[] {
		this.requireActive()
		return Object.freeze(
			[...this.exposures.values()]
				.map(({ name, command }) => Object.freeze({ name, descriptor: command.descriptor }))
				.sort((left, right) => left.name.localeCompare(right.name)),
		)
	}

	private resolveTools(
		options: Readonly<{
			tools?: readonly PiToolChoice[]
			context?: CommandContext
			authorize?: PiAuthorization
			principal?: unknown
		}>,
		owner: CoreContext,
	): readonly SelectedPiCommand[] {
		const choices = options.tools ?? []
		if (!Array.isArray(choices))
			throw new PiAgentError('INVALID_INPUT', 'Session tools must be an array')
		if (choices.every((choice) => typeof choice === 'string') && options.context !== undefined) {
			throw new PiAgentError(
				'INVALID_INPUT',
				'Exposed tools do not accept a session context override',
			)
		}
		const sessionContext =
			options.context === undefined ? undefined : snapshotBusinessContext(options.context)
		const seen = new Set<string>()
		const selected: SelectedPiCommand[] = []
		for (const choice of choices) {
			const exposure = typeof choice === 'string' ? this.exposures.get(choice) : undefined
			if (typeof choice === 'string' && !exposure)
				throw new PiAgentError('TOOL_NOT_FOUND', `Tool "${choice}" is not exposed`)
			const command = (exposure?.command ?? choice) as DirectCommand<any, unknown, any>
			if (
				typeof command?.name !== 'string' ||
				command.name !== command.descriptor?.name ||
				typeof command.execute !== 'function' ||
				'dispose' in command
			) {
				throw new PiAgentError(
					'INVALID_INPUT',
					'Session tools must be direct Commands or exposed names',
				)
			}
			if (seen.has(command.name))
				throw new PiAgentError('TOOL_CONFLICT', `Tool "${command.name}" is selected twice`)
			validatePiSchema(command.descriptor.inputSchema, command.name)
			seen.add(command.name)
			const sourceOwner = exposure?.owner ?? owner
			const checkAuthorization = async (currentSignal: AbortSignal) => {
				if (exposure && !exposure.active) return false
				if (currentSignal.aborted) return false
				if (
					options.authorize &&
					!(await options.authorize({
						name: command.name,
						principal: options.principal,
						signal: currentSignal,
					}))
				)
					return false
				if (currentSignal.aborted || (exposure && !exposure.active)) return false
				if (
					exposure?.options.authorize &&
					!(await exposure.options.authorize({
						name: command.name,
						principal: options.principal,
						signal: currentSignal,
					}))
				)
					return false
				return !currentSignal.aborted && (!exposure || exposure.active)
			}
			const allowed = async (signal?: AbortSignal) => {
				if (exposure && !exposure.active) return false
				let providerLease
				let ownerLease
				try {
					providerLease = enterOwnerInvocation(this.providerOwner, signal)
					ownerLease =
						sourceOwner === this.providerOwner
							? providerLease
							: enterOwnerInvocation(sourceOwner, providerLease.signal)
				} catch {
					providerLease?.dispose()
					return false
				}
				try {
					return await checkAuthorization(ownerLease.signal)
				} finally {
					if (ownerLease !== providerLease) ownerLease.dispose()
					providerLease.dispose()
				}
			}
			selected.push(
				Object.freeze({
					name: command.name,
					descriptor: command.descriptor,
					available: () => !exposure || exposure.active,
					allowed,
					invoke: async (candidate: unknown, sessionId: string, signal?: AbortSignal) => {
						if (exposure && !exposure.active)
							return releasedDelivery(
								Result.err<unknown, CommandFailure>({
									code: 'PUBLICATION_GONE',
									message: 'Tool publication is gone',
								}),
							)
						let providerLease
						try {
							providerLease = enterOwnerInvocation(this.providerOwner, signal)
						} catch (error) {
							return releasedDelivery(
								Result.err<unknown, CommandFailure>({
									code: 'ABORTED',
									message: 'Pi Agent is stopping',
									cause: error,
								}),
							)
						}
						let ownerLease: ReturnType<typeof enterOwnerInvocation> | undefined
						let released = false
						let handedOff = false
						const release = () => {
							if (released) return
							released = true
							try {
								if (ownerLease && ownerLease !== providerLease) ownerLease.dispose()
							} finally {
								providerLease.dispose()
							}
						}
						const deliver = (result: PiToolDelivery['result']): PiToolDelivery => {
							handedOff = true
							return { result, release }
						}
						try {
							ownerLease =
								sourceOwner === this.providerOwner
									? providerLease
									: enterOwnerInvocation(sourceOwner, providerLease.signal)
							const baseContext = exposure?.options.context
								? snapshotBusinessContext(
										await exposure.options.context({
											principal: options.principal,
											signal: ownerLease.signal,
											deadlineMs: undefined,
										}),
									)
								: exposure
									? {}
									: (sessionContext ?? {})
							if (exposure && !exposure.active)
								return deliver(
									Result.err<unknown, CommandFailure>({
										code: 'PUBLICATION_GONE',
										message: 'Tool publication is gone',
									}),
								)
							if (ownerLease.signal.aborted)
								return deliver(
									Result.err<unknown, CommandFailure>({
										code: 'ABORTED',
										message: 'Tool invocation was aborted',
									}),
								)
							if (!(await checkAuthorization(ownerLease.signal)))
								return deliver(
									Result.err<unknown, CommandFailure>({
										code: exposure && !exposure.active ? 'PUBLICATION_GONE' : 'FORBIDDEN',
										message:
											exposure && !exposure.active
												? 'Tool publication is gone'
												: 'Tool is not authorized',
									}),
								)
							if (ownerLease.signal.aborted)
								return deliver(
									Result.err<unknown, CommandFailure>({
										code: 'ABORTED',
										message: 'Tool invocation was aborted',
									}),
								)
							const context = {
								...baseContext,
								signal: ownerLease.signal,
								meta: Object.freeze({ carrier: 'pi-agent', sessionId }),
							}
							return deliver(await command.execute(candidate, context))
						} catch (error) {
							return deliver(
								Result.err<unknown, CommandFailure>({
									code: ownerLease ? 'INTERNAL' : 'ABORTED',
									message: 'Tool execution failed',
									cause: error,
								}),
							)
						} finally {
							if (!handedOff) release()
						}
					},
				}),
			)
		}
		return Object.freeze(selected)
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

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.active = false
		this.subagents.close()
		for (const exposure of this.exposures.values()) {
			exposure.active = false
			exposure.guard?.cancel()
		}
		this.exposures.clear()
		const disposals = [...this.sessionsById.values()]
			.filter((session) => session.depth === 0)
			.map((session) => session.disposeOwned())
		const pendingCreates = [...this.pendingCreates]
		this.closePromise = (async () => {
			const outcomes = await Promise.allSettled([...pendingCreates, ...disposals])
			this.listeners.clear()
			const failures = outcomes.flatMap((outcome, index) =>
				outcome.status === 'rejected' &&
				(index >= pendingCreates.length ||
					!(outcome.reason instanceof PiAgentError && outcome.reason.code === 'NOT_RUNNING'))
					? [outcome.reason]
					: [],
			)
			if (failures.length > 0) throw new AggregateError(failures, 'Pi Agent cleanup failed')
		})()
		return this.closePromise
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
					tools: owner.selectedTools,
					principal: owner.principal,
					owner: owner.owner,
					...(owner.sessionContext ? { context: owner.sessionContext } : {}),
					...(owner.sessionAuthorize ? { authorize: owner.sessionAuthorize } : {}),
					parent: owner,
					depth: owner.depth + 1,
					model: parentModel ?? undefined,
					thinkingLevel: owner.thinkingLevel,
					systemPrompt: `${owner.systemPrompt}\n\nYou are a bounded subagent. Complete only the delegated task and report a concise result.`,
					cwd: owner.cwd,
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
		const session = new ManagedPiSession(this, input, this.reportListenerError)
		try {
			const upstream = await this.engine.createSession({
				cwd: input.cwd,
				systemPrompt: input.systemPrompt,
				thinkingLevel: input.thinkingLevel ?? this.config.thinkingLevel,
				...(model ? { model } : {}),
				tools: await session.toolDefinitions(),
				beforeTurn: () => session.refreshTools(),
			})
			if (!this.active) {
				upstream.dispose()
				throw new PiAgentError('NOT_RUNNING', 'PiAgentPlugin is not running')
			}
			session.attach(upstream)
			if (input.owner !== this.providerOwner) {
				session.setOwnerGuard(
					input.owner.effects.defer(() => session.disposeOwned(), {
						tag: `PiSession:${session.id}`,
					}),
				)
			}
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
	readonly depth: number
	readonly parent?: ManagedPiSession
	readonly thinkingLevel: CreatePiAgentSessionOptions['thinkingLevel']
	readonly systemPrompt: string
	readonly cwd: string
	private readonly createdAt = now()
	private readonly listeners = new Set<(event: PiAgentSessionEvent) => void>()
	private readonly children = new Set<ManagedPiSession>()
	private readonly subagentRecords: MutableSubagent[] = []
	private readonly activePrompts = new Set<Promise<PiAgentRunResult>>()
	private readonly activeSubagents = new Set<Promise<PiSubagentRunResult>>()
	private promptAbort?: AbortController
	private discoveryFailed = false
	private readonly lifetime = new AbortController()
	readonly selectedTools: readonly SelectedPiCommand[]
	readonly principal: unknown
	readonly owner: CoreContext
	readonly sessionContext?: CommandContext
	readonly sessionAuthorize?: PiAuthorization
	private visibleTools: readonly SelectedPiCommand[] = []
	private upstream?: AgentSession
	private unsubscribeUpstream?: () => void
	private state: PiAgentSessionSnapshot['state'] = 'idle'
	private goalValue: PiGoalSnapshot | null = null
	private lastResponse?: string
	private disposePromise?: Promise<void>
	private ownerGuard?: { cancel(): void }

	constructor(
		private readonly controller: PiAgentController,
		input: SessionCreateInput,
		private readonly reportListenerError: (error: unknown) => void,
	) {
		this.id = input.id
		this.selectedTools = input.tools
		this.principal = input.principal
		this.owner = input.owner
		this.sessionContext = input.context
		this.sessionAuthorize = input.authorize
		this.parent = input.parent
		this.depth = input.depth
		this.thinkingLevel = input.thinkingLevel
		this.systemPrompt = input.systemPrompt
		this.cwd = input.cwd
	}

	setOwnerGuard(guard: { cancel(): void }): void {
		this.ownerGuard = guard
	}

	get subagentCount(): number {
		return this.subagentRecords.length
	}

	attach(upstream: AgentSession): void {
		this.upstream = upstream
		this.unsubscribeUpstream = upstream.subscribe((event) => this.onUpstreamEvent(event))
	}

	async toolDefinitions(): Promise<ToolDefinition[]> {
		const checks = await Promise.allSettled(
			this.selectedTools.map(async (tool) => ({
				tool,
				allowed: await tool.allowed(this.lifetime.signal),
			})),
		)
		const permitted: Array<{ tool: SelectedPiCommand; allowed: boolean }> = []
		for (const check of checks) {
			if (check.status === 'rejected') throw check.reason
			permitted.push(check.value)
		}
		if (this.state === 'disposed') return []
		this.visibleTools = Object.freeze(
			permitted.filter(({ tool, allowed }) => tool.available() && allowed).map(({ tool }) => tool),
		)
		const tools = this.visibleTools.map((tool): SelectedPiCommand => ({
			...tool,
			invoke: (candidate, sessionId, signal) =>
				this.state === 'disposed'
					? Promise.resolve(
							releasedDelivery(
								Result.err<unknown, CommandFailure>({
									code: 'PUBLICATION_GONE',
									message: 'Pi session is disposed',
								}),
							),
						)
					: tool.invoke(
							candidate,
							sessionId,
							signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
						),
		}))
		return createPiToolDefinitions({
			sessionId: this.id,
			tools,
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

	async refreshTools(): Promise<void> {
		if (!this.upstream || this.state === 'disposed') return
		this.visibleTools = Object.freeze([])
		this.upstream.agent.state.tools = []
		this.changed()
		let definitions: ToolDefinition[]
		try {
			definitions = await this.toolDefinitions()
		} catch (error) {
			this.visibleTools = Object.freeze([])
			this.upstream.agent.state.tools = []
			this.discoveryFailed = true
			this.changed()
			throw error
		}
		if (this.isDisposed()) return
		this.upstream.agent.state.tools = toPiAgentTools(definitions)
		this.changed()
	}

	snapshot(): PiAgentSessionSnapshot {
		const model = this.modelReference()
		return Object.freeze({
			id: this.id,
			...(this.parent ? { parentSessionId: this.parent.id } : {}),
			depth: this.depth,
			state: this.state,
			model,
			goal: this.goalValue ? Object.freeze({ ...this.goalValue }) : null,
			availableCommandNames: Object.freeze(this.visibleTools.map(({ name }) => name)),
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
		const task = this.promptNow(text, options, upstream)
		this.activePrompts.add(task)
		try {
			return await task
		} finally {
			this.activePrompts.delete(task)
		}
	}

	private async promptNow(
		text: string,
		options: PiAgentPromptOptions,
		upstream: AgentSession,
	): Promise<PiAgentRunResult> {
		const promptAbort = new AbortController()
		this.promptAbort = promptAbort
		this.discoveryFailed = false
		this.state = 'running'
		this.changed()
		const abort = (): void => {
			void this.abort()
		}
		options.signal?.addEventListener('abort', abort, { once: true })
		try {
			await this.refreshTools()
			if (promptAbort.signal.aborted || this.lifetime.signal.aborted || options.signal?.aborted) {
				return Object.freeze({ ok: false, reason: 'aborted', message: 'Prompt was aborted' })
			}
			await upstream.prompt(text)
			if (this.discoveryFailed) {
				return Object.freeze({ ok: false, reason: 'model_error', message: 'Tool discovery failed' })
			}
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
			if (
				promptAbort.signal.aborted ||
				this.lifetime.signal.aborted ||
				options.signal?.aborted ||
				isAbortError(error)
			) {
				return Object.freeze({ ok: false, reason: 'aborted', message: 'Prompt was aborted' })
			}
			return Object.freeze({
				ok: false,
				reason: 'model_error',
				message: this.discoveryFailed ? 'Tool discovery failed' : publicErrorMessage(error),
			})
		} finally {
			options.signal?.removeEventListener('abort', abort)
			if (this.promptAbort === promptAbort) this.promptAbort = undefined
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
		return this.trackSubagent(this.controller.runSubagent(this, task, signal))
	}

	private spawnSubagentWithSignal(
		task: string,
		signal?: AbortSignal,
	): Promise<PiSubagentRunResult> {
		const composed = signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal
		return this.trackSubagent(this.controller.runSubagent(this, task, composed))
	}

	private trackSubagent(task: Promise<PiSubagentRunResult>): Promise<PiSubagentRunResult> {
		this.activeSubagents.add(task)
		void task.then(
			() => this.activeSubagents.delete(task),
			() => this.activeSubagents.delete(task),
		)
		return task
	}

	async abort(): Promise<void> {
		if (this.state === 'disposed' || !this.upstream) return
		this.promptAbort?.abort()
		if (this.state === 'running') this.state = 'aborting'
		this.changed()
		await this.upstream.abort()
		await this.upstream.agent.waitForIdle()
		if (!this.isDisposed() && this.activePrompts.size === 0) this.state = 'idle'
		this.changed()
	}

	dispose(): Promise<void> {
		return this.disposeOwned()
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
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
		this.ownerGuard?.cancel()
		this.unsubscribeUpstream?.()
		const childOutcomes = await Promise.allSettled(
			[...this.children].map((child) => child.disposeOwned()),
		)
		const failures = childOutcomes.flatMap((outcome) =>
			outcome.status === 'rejected' ? [outcome.reason] : [],
		)
		const subagentOutcomes = await Promise.allSettled(this.activeSubagents)
		for (const outcome of subagentOutcomes) {
			if (outcome.status === 'rejected' && !failures.includes(outcome.reason))
				failures.push(outcome.reason)
		}
		try {
			if (this.upstream) {
				try {
					try {
						await this.upstream.abort()
						await this.upstream.agent.waitForIdle()
					} finally {
						await Promise.allSettled(this.activePrompts)
					}
				} finally {
					this.upstream.dispose()
				}
			}
		} catch (cause) {
			failures.push(cause)
		} finally {
			this.listeners.clear()
			this.controller.remove(this)
		}
		if (failures.length > 0) throw new AggregateError(failures, 'Pi session cleanup failed')
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

function releasedDelivery(result: PiToolDelivery['result']): PiToolDelivery {
	return { result, release() {} }
}

function snapshotBusinessContext(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new PiAgentError('INVALID_INPUT', 'Tool context must be a data record')
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new PiAgentError('INVALID_INPUT', 'Tool context must be a data record')
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new PiAgentError('INVALID_INPUT', 'Tool context must be a data record')
	}
	const snapshot: Record<string, unknown> = Object.create(null)
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (key === 'signal' || key === 'deadlineMs' || key === 'meta') {
			throw new PiAgentError('INVALID_INPUT', `Tool context cannot supply reserved field "${key}"`)
		}
		if (!descriptor.enumerable || !('value' in descriptor)) {
			throw new PiAgentError('INVALID_INPUT', 'Tool context must be a data record')
		}
		snapshot[key] = descriptor.value
	}
	return snapshot
}

const unsupportedPiSchemaKeys = new Set([
	'$ref',
	'$defs',
	'definitions',
	'allOf',
	'oneOf',
	'patternProperties',
	'dependentSchemas',
	'dependencies',
	'unevaluatedProperties',
	'propertyNames',
	'contains',
	'prefixItems',
	'not',
	'if',
	'then',
	'else',
])

function validatePiSchema(value: unknown, name: string, path = 'input'): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new PiAgentError(
			'TOOL_SCHEMA_UNSUPPORTED',
			`Pi tool "${name}" has an unsupported schema at ${path}`,
		)
	}
	const schema = value as Record<string, unknown>
	for (const key of Object.keys(schema)) {
		if (unsupportedPiSchemaKeys.has(key)) {
			throw new PiAgentError(
				'TOOL_SCHEMA_UNSUPPORTED',
				`Pi tool "${name}" does not support ${key} at ${path}`,
			)
		}
	}
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
		throw new PiAgentError(
			'TOOL_SCHEMA_UNSUPPORTED',
			`Pi tool "${name}" requires closed objects at ${path}`,
		)
	}
	if (schema.properties !== undefined) {
		if (
			!schema.properties ||
			typeof schema.properties !== 'object' ||
			Array.isArray(schema.properties)
		) {
			throw new PiAgentError(
				'TOOL_SCHEMA_UNSUPPORTED',
				`Pi tool "${name}" has invalid properties at ${path}`,
			)
		}
		for (const [key, child] of Object.entries(schema.properties))
			validatePiSchema(child, name, `${path}.${key}`)
	}
	if (schema.items !== undefined) {
		if (Array.isArray(schema.items))
			throw new PiAgentError(
				'TOOL_SCHEMA_UNSUPPORTED',
				`Pi tool "${name}" does not support tuple items at ${path}`,
			)
		validatePiSchema(schema.items, name, `${path}.items`)
	}
	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
			throw new PiAgentError(
				'TOOL_SCHEMA_UNSUPPORTED',
				`Pi tool "${name}" has invalid anyOf at ${path}`,
			)
		}
		for (const [index, child] of schema.anyOf.entries()) {
			if (child && typeof child === 'object' && ('properties' in child || 'items' in child)) {
				throw new PiAgentError(
					'TOOL_SCHEMA_UNSUPPORTED',
					`Pi tool "${name}" does not support object or array unions at ${path}`,
				)
			}
			validatePiSchema(child, name, `${path}.anyOf[${index}]`)
		}
	}
}
