import { createTestHost } from '@pluxel/test'
import { defineCommand, Result, type CommandContext } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import type {
	AgentSession,
	AgentSessionEvent,
	ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { BasePlugin, Plugin, type Context as CoreContext } from '@pluxel/core'
import { closeOwnerInvocations } from '@pluxel/core/internal'
import { describe, expect, it, vi } from 'vitest'
import type { PiAgentPluginConfig } from '../src/config.ts'
import { PiAgentController } from '../src/controller.ts'
import {
	DefaultPiEngine,
	type PiEngine,
	type PiEngineCreateOptions,
	type ResolvedPiModel,
} from '../src/engine.ts'
import { PiAgentPlugin } from '../src/index.ts'

const echoCommand = defineCommand({
	name: 'notes.echo',
	description: 'Echo one note.',
	input: obj({ text: Type.String() }),
	execute: ({ text }) => Result.ok({ text }),
})

@Plugin()
class NotesPublisher extends BasePlugin {
	constructor(private readonly agent: PiAgentPlugin) {
		super()
	}
	protected override init(): void {
		this.agent.expose(echoCommand)
	}
}

const config: PiAgentPluginConfig = {
	thinkingLevel: 'medium',
	systemPrompt: 'Use Pluxel tools.',
	cwd: '.',
	maxSessions: 8,
	maxSubagentDepth: 2,
	maxSubagentsPerSession: 4,
	maxConcurrentSubagents: 2,
	maxToolResultChars: 100_000,
}

class FakeSession {
	readonly listeners = new Set<(event: AgentSessionEvent) => void>()
	readonly messages: unknown[] = []
	readonly model = { provider: 'fake', id: 'model' }
	readonly abort = vi.fn(async () => {})
	readonly dispose = vi.fn(() => {})
	readonly waitForIdle = vi.fn(async () => {})
	readonly agent = {
		state: { tools: [] as AgentSession['agent']['state']['tools'] },
		waitForIdle: this.waitForIdle,
	}

	async prompt(text: string): Promise<void> {
		this.messages.push({
			role: 'assistant',
			stopReason: 'stop',
			content: [{ type: 'text', text: `completed: ${text}` }],
		})
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
}

class FakeEngine implements PiEngine {
	readonly created: Array<{ options: PiEngineCreateOptions; session: FakeSession }> = []

	resolveModel(): ResolvedPiModel | undefined {
		return { provider: 'fake', id: 'model' } as ResolvedPiModel
	}

	async createSession(options: PiEngineCreateOptions): Promise<AgentSession> {
		const session = new FakeSession()
		this.created.push({ options, session })
		return session as unknown as AgentSession
	}
}

class BlockingEngine extends FakeEngine {
	blockNext = false
	private pendingOptions?: PiEngineCreateOptions
	private releasePending?: (session: AgentSession) => void

	override async createSession(options: PiEngineCreateOptions): Promise<AgentSession> {
		if (!this.blockNext) return await super.createSession(options)
		this.blockNext = false
		this.pendingOptions = options
		return await new Promise<AgentSession>((resolve) => {
			this.releasePending = resolve
		})
	}

	hasPendingCreate(): boolean {
		return this.releasePending !== undefined
	}

	finishPendingCreate(): FakeSession {
		if (!this.pendingOptions || !this.releasePending) throw new Error('No pending Pi session')
		const session = new FakeSession()
		this.created.push({ options: this.pendingOptions, session })
		this.releasePending(session as unknown as AgentSession)
		this.pendingOptions = undefined
		this.releasePending = undefined
		return session
	}
}

describe('Pi direct tools', () => {
	it('delivers recoverable Command failures to the model', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const read = defineCommand({
			name: 'notes.read',
			description: 'Read a note.',
			input: obj({ id: Type.String({ minLength: 1 }) }),
			execute({ id }) {
				if (id === 'missing')
					return Result.err({
						code: 'REJECTED',
						reason: 'not_found',
						message: 'Note does not exist',
						cause: new Error('private database detail'),
					})
				return Result.ok({ id })
			},
		})
		const session = await controller.createSession({ tools: [read] })
		const tools = engine.created[0]!.options.tools
		const command = tools.find((tool) => tool.label === 'notes.read')!
		const rejected = await execute(command, { id: 'missing' }).then(
			(): undefined => undefined,
			(error: Error) => error,
		)
		expect(JSON.parse(rejected!.message)).toMatchObject({
			code: 'REJECTED',
			reason: 'not_found',
			message: 'Note does not exist',
		})
		expect(rejected!.message).not.toContain('private database detail')
		const invalid = await execute(command, { id: 42 }).then(
			(): undefined => undefined,
			(error: Error) => error,
		)
		expect(JSON.parse(invalid!.message)).toMatchObject({
			code: 'INPUT_VALIDATION',
			issues: [expect.objectContaining({ message: expect.any(String) })],
		})
		await session.dispose()
		await controller.close()
	})

	it('keeps prompt outcomes, goal, subagent and disposal behavior', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const session = await controller.createSession({ tools: [echoCommand] })
		expect(session.snapshot().availableCommandNames).toEqual(['notes.echo'])
		session.setGoal('Check a note')
		expect(session.snapshot().goal).toMatchObject({ text: 'Check a note', status: 'active' })
		expect(await session.prompt('notes')).toMatchObject({ ok: true, text: 'completed: notes' })
		expect(await session.prompt('notes', { signal: AbortSignal.abort() })).toMatchObject({
			ok: false,
			reason: 'aborted',
		})
		vi.spyOn(engine.created[0]!.session, 'prompt').mockRejectedValueOnce(
			new Error('model unavailable'),
		)
		expect(await session.prompt('notes')).toMatchObject({ ok: false, reason: 'model_error' })
		const child = await session.spawnSubagent('Review lifecycle')
		expect(child).toMatchObject({ ok: true, text: 'completed: Review lifecycle' })
		expect(engine.created).toHaveLength(2)
		expect(
			engine.created[1]!.options.tools.some(({ description }) =>
				description.includes('Echo one note'),
			),
		).toBe(true)
		await session.dispose()
		expect(engine.created[0]!.session.dispose).toHaveBeenCalledOnce()
		await expect(session.prompt('notes')).rejects.toMatchObject({ code: 'NOT_RUNNING' })
		await controller.close()
	})

	it('attributes inherited Command calls to the child session', async () => {
		class ToolCallingEngine extends FakeEngine {
			childOutput?: Awaited<ReturnType<typeof execute>>

			override async createSession(options: PiEngineCreateOptions): Promise<AgentSession> {
				const session = await super.createSession(options)
				if (this.created.length === 2) {
					const child = this.created[1]!.session
					const prompt = child.prompt.bind(child)
					child.prompt = async (text) => {
						this.childOutput = await execute(commandTool(options.tools), {})
						await prompt(text)
					}
				}
				return session
			}
		}
		const owner = fakeOwner()
		const engine = new ToolCallingEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const command = defineCommand({
			name: 'session.identity',
			description: 'Return the current session id.',
			input: obj({}),
			execute(_input, context: CommandContext) {
				return Result.ok(context.meta?.sessionId)
			},
		})
		const parent = await controller.createSession({ id: 'parent-id', tools: [command] })
		expect(await execute(commandTool(engine.created[0]!.options.tools), {})).toMatchObject({
			content: [{ text: 'parent-id' }],
		})
		const child = await parent.spawnSubagent('Check session identity')
		expect(child.ok).toBe(true)
		expect(engine.childOutput).toMatchObject({ content: [{ text: child.id }] })
		await parent.dispose()
		await controller.close()
	})

	it('waits for an inherited-tool child still being created when its parent closes', async () => {
		const owner = fakeOwner()
		const engine = new BlockingEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const parent = await controller.createSession({ tools: [echoCommand] })
		engine.blockNext = true
		const pending = parent.spawnSubagent('Check one note')
		await vi.waitFor(() => expect(engine.hasPendingCreate()).toBe(true))
		let closed = false
		const closing = parent.dispose().then(() => {
			closed = true
		})
		await vi.waitFor(() => expect(parent.snapshot().state).toBe('disposed'))
		expect(closed).toBe(false)
		const child = engine.finishPendingCreate()
		await expect(pending).resolves.toMatchObject({ ok: false, reason: 'aborted' })
		await closing
		expect(child.dispose).toHaveBeenCalledOnce()
		expect(controller.sessions()).toEqual([])
		await controller.close()
	})

	it('selects only explicit tools and rechecks policy on every callback', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		using _exposure = controller.expose(owner, echoCommand, {})
		expect(controller.tools().map(({ name }) => name)).toEqual(['notes.echo'])
		let allowed = true
		const session = await controller.createSession({
			tools: ['notes.echo'],
			principal: { id: 'alice' },
			authorize: () => allowed,
		})
		const tool = commandTool(engine.created[0]!.options.tools)
		expect(tool.executionMode).toBe('sequential')
		expect(await execute(tool, { text: 'hello' })).toMatchObject({
			content: [{ text: '{"text":"hello"}' }],
		})
		allowed = false
		await expect(execute(tool, { text: 'hello' })).rejects.toThrow('not authorized')
		await session.prompt('next turn')
		expect(
			engine.created[0]!.session.agent.state.tools.some(({ label }) => label === 'notes.echo'),
		).toBe(false)
		_exposure.dispose()
		allowed = true
		using _replacement = controller.expose(owner, echoCommand, {})
		await expect(execute(tool, { text: 'hello' })).rejects.toThrow('publication is gone')
		await session.dispose()
		await expect(execute(tool, { text: 'hello' })).rejects.toThrow('Pi session is disposed')
		const fresh = await controller.createSession({ tools: ['notes.echo'] })
		expect(fresh.snapshot().availableCommandNames).toEqual(['notes.echo'])
		await controller.close()
	})

	it.each(['provider', 'publisher'] as const)(
		'holds the %s owner while checking visible tool authorization',
		async (stoppedOwner) => {
			const provider = fakeOwner()
			const publisher = fakeOwner(provider)
			const engine = new FakeEngine()
			const controller = new PiAgentController(provider, engine, config, () => {})
			let authorizeStarted!: () => void
			const started = new Promise<void>((resolve) => {
				authorizeStarted = resolve
			})
			let finishAuthorization!: (allowed: boolean) => void
			using _exposure = controller.expose(publisher, echoCommand, {
				authorize: () => {
					authorizeStarted()
					return new Promise<boolean>((resolve) => {
						finishAuthorization = resolve
					})
				},
			})
			const pending = controller.createSession({ tools: ['notes.echo'] })
			await started
			let stopped = false
			const closing = Promise.resolve(
				closeOwnerInvocations(stoppedOwner === 'provider' ? provider : publisher),
			).then((): undefined => {
				stopped = true
				return undefined
			})
			await Promise.resolve()
			expect(stopped).toBe(false)
			finishAuthorization(true)
			const session = await pending
			await closing
			expect(session.snapshot().availableCommandNames).toEqual([])
			await session.dispose()
			await controller.close()
		},
	)

	it('uses session context for direct commands and exposure context for named tools', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		interface NoteContext extends CommandContext {
			actorId: string
		}
		const command = defineCommand({
			name: 'note.actor',
			description: 'Return the actor.',
			input: obj({}),
			execute(_input, context: NoteContext) {
				return Result.ok(context.actorId)
			},
		})
		const direct = await controller.createSession({
			tools: [command],
			context: { actorId: 'direct' },
		})
		expect(await execute(commandTool(engine.created[0]!.options.tools), {})).toMatchObject({
			content: [{ text: 'direct' }],
		})
		using _exposure = controller.expose(owner, command, {
			context: ({ principal }) => ({ actorId: String(principal) }),
		})
		const named = await controller.createSession({ tools: ['note.actor'], principal: 'published' })
		expect(await execute(commandTool(engine.created[1]!.options.tools), {})).toMatchObject({
			content: [{ text: 'published' }],
		})
		await expect(
			controller.createSession({
				tools: ['note.actor'],
				context: { actorId: 'override' },
			} as never),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		await direct.dispose()
		await named.dispose()
		await controller.close()
	})

	it('pins business context fields before session use and awaited authorization', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		interface ActorContext extends CommandContext {
			actorId: string
		}
		const command = defineCommand({
			name: 'note.pinned-actor',
			description: 'Return the pinned actor.',
			input: obj({}),
			execute(_input, context: ActorContext) {
				return Result.ok(context.actorId)
			},
		})
		const directContext = { actorId: 'alice' }
		const direct = await controller.createSession({ tools: [command], context: directContext })
		directContext.actorId = 'mallory'
		expect(await execute(commandTool(engine.created[0]!.options.tools), {})).toMatchObject({
			content: [{ text: 'alice' }],
		})

		const sharedContext = { actorId: 'alice' }
		let markAuthorizationStarted!: () => void
		const authorizationStarted = new Promise<void>((resolve) => {
			markAuthorizationStarted = resolve
		})
		let finishAuthorization!: (allowed: boolean) => void
		const authorization = new Promise<boolean>((resolve) => {
			finishAuthorization = resolve
		})
		let waitForAuthorization = false
		using _exposure = controller.expose(owner, command, {
			context: () => sharedContext,
			authorize: () => {
				if (!waitForAuthorization) return true
				markAuthorizationStarted()
				return authorization
			},
		})
		const named = await controller.createSession({ tools: ['note.pinned-actor'] })
		waitForAuthorization = true
		const pending = execute(commandTool(engine.created[1]!.options.tools), {})
		await authorizationStarted
		sharedContext.actorId = 'mallory'
		finishAuthorization(true)
		expect(await pending).toMatchObject({ content: [{ text: 'alice' }] })
		await direct.dispose()
		await named.dispose()
		await controller.close()
	})

	it('constructs business context before operation authorization under one signal', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		interface NoteContext extends CommandContext {
			actorId: string
		}
		const order: string[] = []
		let factorySignal: AbortSignal | undefined
		const authorizationSignals: AbortSignal[] = []
		let handlerCalls = 0
		const command = defineCommand({
			name: 'note.sequence',
			description: 'Return a scoped note.',
			input: obj({}),
			execute(_input, context: NoteContext) {
				handlerCalls++
				order.push('handler')
				return Result.ok({ actorId: context.actorId, sessionId: context.meta?.sessionId })
			},
		})
		const principal = { id: 'alice' }
		using _exposure = controller.expose(owner, command, {
			context: async ({ principal: actor, signal, deadlineMs }) => {
				order.push('context')
				expect(actor).toBe(principal)
				expect(deadlineMs).toBeUndefined()
				factorySignal = signal
				return { actorId: (actor as { id: string }).id }
			},
		})
		const session = await controller.createSession({
			tools: ['note.sequence'],
			id: 'known-id',
			principal,
			authorize: ({ signal }) => {
				order.push('authorize')
				authorizationSignals.push(signal)
				return true
			},
		})
		order.length = 0
		const output = await execute(commandTool(engine.created[0]!.options.tools), {})
		expect(output.content).toMatchObject([{ text: '{"actorId":"alice","sessionId":"known-id"}' }])
		expect(order).toEqual(['context', 'authorize', 'handler'])
		expect(authorizationSignals.at(-1)).toBe(factorySignal)
		expect(factorySignal?.aborted).toBe(false)
		expect(handlerCalls).toBe(1)
		await session.dispose()
		await controller.close()
	})

	it('does not execute after publication withdrawal during context preparation', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		let release!: () => void
		let handlerCalls = 0
		let factoryCalls = 0
		const command = defineCommand({
			name: 'note.prepare',
			description: 'Prepare a note.',
			input: obj({}),
			execute() {
				handlerCalls++
				return Result.ok()
			},
		})
		using _exposure = controller.expose(owner, command, {
			context: async () => {
				factoryCalls++
				await new Promise<void>((resolve) => {
					release = resolve
				})
				return {}
			},
		})
		const session = await controller.createSession({ tools: ['note.prepare'] })
		const pending = execute(commandTool(engine.created[0]!.options.tools), {})
		await vi.waitFor(() => expect(factoryCalls).toBe(1))
		_exposure.dispose()
		release()
		await expect(pending).rejects.toThrow('publication is gone')
		expect(handlerCalls).toBe(0)
		await session.dispose()
		await controller.close()
	})

	it('does not let an awaited authorization revive a withdrawn publication', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		let release!: (allowed: boolean) => void
		let calls = 0
		using _exposure = controller.expose(owner, echoCommand, {})
		const session = await controller.createSession({
			tools: ['notes.echo'],
			authorize: () => {
				calls++
				return calls === 1
					? true
					: new Promise<boolean>((resolve) => {
							release = resolve
						})
			},
		})
		const pending = execute(commandTool(engine.created[0]!.options.tools), { text: 'hello' })
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		_exposure.dispose()
		release(true)
		await expect(pending).rejects.toThrow('publication is gone')
		await session.dispose()
		await controller.close()
	})

	it('waits for pending tool discovery and does not prompt after session disposal', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		let release: ((allowed: boolean) => void) | undefined
		let checks = 0
		const session = await controller.createSession({
			tools: [echoCommand],
			authorize: () => {
				checks++
				return checks === 1
					? true
					: new Promise<boolean>((resolve) => {
							release = resolve
						})
			},
		})
		const upstream = engine.created[0]!.session
		const pending = session.prompt('hello')
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		let closed = false
		const closing = session.dispose().then((): undefined => {
			closed = true
			return undefined
		})
		await vi.waitFor(() => expect(upstream.abort).toHaveBeenCalledOnce())
		expect(closed).toBe(false)
		release!(true)
		await expect(pending).resolves.toEqual({
			ok: false,
			reason: 'aborted',
			message: 'Prompt was aborted',
		})
		await closing
		expect(upstream.messages).toEqual([])
		expect(upstream.dispose).toHaveBeenCalledOnce()
		await controller.close()
	})

	it('aborts a prompt waiting for tool authorization without starting the model', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		let release: (() => void) | undefined
		let checks = 0
		const session = await controller.createSession({
			tools: [echoCommand],
			authorize: () => {
				checks++
				return checks === 1
					? true
					: new Promise<boolean>((resolve) => {
							release = () => resolve(true)
						})
			},
		})
		const upstream = engine.created[0]!.session
		const pending = session.prompt('hello')
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		await session.abort()
		expect(session.snapshot().state).toBe('aborting')
		await expect(session.prompt('second')).rejects.toMatchObject({ code: 'SESSION_BUSY' })
		release!()
		await expect(pending).resolves.toMatchObject({ ok: false, reason: 'aborted' })
		expect(upstream.messages).toEqual([])
		expect(session.snapshot().state).toBe('idle')
		await session.dispose()
		await controller.close()
	})

	it('clears stale tools when SDK turn discovery authorization fails', async () => {
		class FailingTurnEngine extends FakeEngine {
			toolsAfterFailure?: readonly string[]

			override async createSession(options: PiEngineCreateOptions): Promise<AgentSession> {
				const session = await super.createSession(options)
				const upstream = this.created.at(-1)!.session
				const prompt = upstream.prompt.bind(upstream)
				upstream.prompt = async (text) => {
					expect(upstream.agent.state.tools.some(({ label }) => label === echoCommand.name)).toBe(
						true,
					)
					try {
						await options.beforeTurn?.()
					} catch {
						// The Pi SDK reports extension errors and continues the turn.
					}
					this.toolsAfterFailure = upstream.agent.state.tools.map(({ name }) => name)
					await prompt(text)
				}
				return session
			}
		}
		const owner = fakeOwner()
		const engine = new FailingTurnEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		let checks = 0
		const session = await controller.createSession({
			tools: [echoCommand],
			authorize: () => {
				checks++
				if (checks === 3) throw new Error('private policy details')
				return true
			},
		})
		await expect(session.prompt('hello')).resolves.toEqual({
			ok: false,
			reason: 'model_error',
			message: 'Tool discovery failed',
		})
		expect(engine.toolsAfterFailure).toEqual([])
		expect(session.snapshot().availableCommandNames).toEqual([])
		await session.dispose()
		await controller.close()
	})

	it('rejects reserved context fields at runtime', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		await expect(
			controller.createSession({
				tools: [echoCommand],
				context: { signal: AbortSignal.abort() },
			} as never),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		using _exposure = controller.expose(owner, echoCommand, {
			context: (() => ({ signal: AbortSignal.abort() })) as never,
		})
		const session = await controller.createSession({ tools: ['notes.echo'] })
		await expect(
			execute(commandTool(engine.created[0]!.options.tools), { text: 'x' }),
		).rejects.toThrow('Tool execution failed')
		await session.dispose()
		await controller.close()
	})

	it('checks typed direct contexts and reserved context fields', () => {
		interface NoteContext extends CommandContext {
			actorId: string
		}
		const command = defineCommand({
			name: 'note.typed',
			description: 'Return the actor.',
			input: obj({}),
			execute(_input, context: NoteContext) {
				return Result.ok(context.actorId)
			},
		})
		interface TenantContext extends CommandContext {
			tenantId: string
		}
		const tenantCommand = defineCommand({
			name: 'note.tenant',
			description: 'Return the tenant.',
			input: obj({}),
			execute(_input, context: TenantContext) {
				return Result.ok(context.tenantId)
			},
		})
		const api = null as unknown as PiAgentPlugin
		const factoryWithSignal = (_input: { principal: unknown }) => ({
			actorId: 'alice',
			signal: AbortSignal.abort(),
		})
		const probe = () => {
			// @ts-expect-error Required business context cannot be omitted.
			void api.createSession({ tools: [command] })
			void api.createSession({ tools: [command], context: { actorId: 'alice' } })
			// @ts-expect-error String-only selections cannot override exposure context.
			void api.createSession({ tools: ['note.typed'], context: { actorId: 'alice' } })
			const invalidContext = { actorId: 'alice', signal: AbortSignal.abort() }
			// @ts-expect-error Reserved signal is carrier-owned even on a predeclared object.
			void api.createSession({ tools: [command], context: invalidContext })
			// @ts-expect-error Every direct command's business context is required.
			void api.createSession({ tools: [command, tenantCommand], context: { actorId: 'alice' } })
			void api.createSession({
				tools: [command, tenantCommand],
				context: { actorId: 'alice', tenantId: 'acme' },
			})
			// @ts-expect-error Exposing a command with required business fields requires a factory.
			void api.expose(command)
			// @ts-expect-error A predeclared factory cannot return reserved fields.
			void api.expose(command, { context: factoryWithSignal })
		}
		expect(typeof probe).toBe('function')
	})

	it('rejects absent and duplicate selections without changing publications', async () => {
		const owner = fakeOwner()
		const controller = new PiAgentController(owner, new FakeEngine(), config, () => {})
		await expect(controller.createSession({ tools: ['missing'] })).rejects.toMatchObject({
			code: 'TOOL_NOT_FOUND',
		})
		await expect(
			controller.createSession({ tools: [echoCommand, echoCommand] }),
		).rejects.toMatchObject({ code: 'TOOL_CONFLICT' })
		expect(controller.tools()).toEqual([])
		await controller.close()
	})

	it('projects strings as text and rejects non-JSON output without rerunning handlers', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const values: unknown[] = [
			'hello',
			BigInt(1),
			Number.NaN,
			new Date(),
			new (class Value {
				x = 1
			})(),
			{
				toJSON() {
					return 1
				},
			},
		]
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				throw new Error('getter executed')
			},
		})
		values.push(accessor)
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		values.push(cycle)
		let calls = 0
		const projected: unknown[] = []
		for (const [index, value] of values.entries()) {
			const command = defineCommand({
				name: `value.${index}`,
				description: 'Return a test value.',
				input: obj({}),
				execute() {
					calls++
					return Result.ok(value)
				},
			})
			const session = await controller.createSession({ tools: [command] })
			const tool = commandTool(engine.created[index]!.options.tools)
			try {
				projected.push(await execute(tool, {}))
			} catch (error) {
				projected.push(error)
			}
			await session.dispose()
		}
		expect(projected).toEqual([
			expect.objectContaining({ content: [{ type: 'text', text: 'hello' }] }),
			...values.slice(1).map(() => expect.objectContaining({ code: 'OUTPUT_ENCODING' })),
		])
		expect(calls).toBe(values.length)
		await controller.close()
	})

	it('holds the publisher owner until Pi finishes presenting Command output', async () => {
		const provider = fakeOwner()
		const publisher = fakeOwner(provider)
		const engine = new FakeEngine()
		const controller = new PiAgentController(provider, engine, config, () => {})
		let stopping: void | Promise<void>
		const value = new Proxy(
			{ text: 'ready' },
			{
				getPrototypeOf(target) {
					stopping = closeOwnerInvocations(publisher)
					return Reflect.getPrototypeOf(target)
				},
			},
		)
		const command = defineCommand({
			name: 'presentation.held',
			description: 'Return a value observed during presentation.',
			input: obj({}),
			execute() {
				return Result.ok(value)
			},
		})
		using _exposure = controller.expose(publisher, command, {})
		const session = await controller.createSession({ tools: [command.name] })
		const output = await execute(commandTool(engine.created[0]!.options.tools), {})
		expect(output.content).toEqual([{ type: 'text', text: '{"text":"ready"}' }])
		expect(stopping).toBeInstanceOf(Promise)
		await stopping
		await session.dispose()
		await controller.close()
	})

	it('reports output limits as SDK failure without truncation or rerun', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		let calls = 0
		const command = defineCommand({
			name: 'large.output',
			description: 'Return a large value.',
			input: obj({}),
			execute() {
				calls++
				return Result.ok('x'.repeat(config.maxToolResultChars + 1))
			},
		})
		const session = await controller.createSession({ tools: [command] })
		let failure: unknown
		try {
			await execute(commandTool(engine.created[0]!.options.tools), {})
		} catch (error) {
			failure = error
		}
		expect(failure).toMatchObject({ code: 'OUTPUT_LIMIT' })
		expect(calls).toBe(1)
		await session.dispose()
		await controller.close()
	})

	it('rejects unsupported Pi schemas and preserves input examples', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const withExample = defineCommand({
			name: 'text.example',
			description: 'Read example text.',
			input: obj({ text: Type.String() }, { examples: [{ text: 'hello' }] }),
			execute({ text }) {
				return Result.ok(text)
			},
		})
		await controller.createSession({ tools: [withExample] })
		expect(commandTool(engine.created[0]!.options.tools).parameters).toMatchObject({
			examples: [{ text: 'hello' }],
		})
		const tuple = defineCommand({
			name: 'text.tuple',
			description: 'Read a tuple.',
			input: obj({ pair: Type.Tuple([Type.String(), Type.String()]) }),
			execute() {
				return Result.ok()
			},
		})
		await expect(controller.createSession({ tools: [tuple] })).rejects.toMatchObject({
			code: 'TOOL_SCHEMA_UNSUPPORTED',
		})
		await controller.close()
	})

	it('waits for every discovery authorization before failing session creation', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const secondCommand = defineCommand({
			name: 'notes.second',
			description: 'Read another note.',
			input: obj({}),
			execute: () => Result.ok(),
		})
		const failure = new Error('Authorization failed')
		let release: (() => void) | undefined
		let settled = false
		const pending = controller
			.createSession({
				tools: [echoCommand, secondCommand],
				authorize: ({ name }) => {
					if (name === echoCommand.name) throw failure
					return new Promise<boolean>((resolve) => {
						release = () => resolve(true)
					})
				},
			})
			.then(
				(): undefined => undefined,
				(error: unknown) => {
					settled = true
					return error
				},
			)
		await vi.waitFor(() => expect(release).toBeTypeOf('function'))
		expect(settled).toBe(false)
		release!()
		expect(await pending).toBe(failure)
		expect(engine.created).toEqual([])
		await controller.close()
	})

	it('stops sessions while a pending creation settles', async () => {
		const owner = fakeOwner()
		const engine = new BlockingEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		await controller.createSession()
		engine.blockNext = true
		const pending = controller.createSession({ id: 'pending' }).then(
			(): undefined => undefined,
			(error: unknown) => error,
		)
		await vi.waitFor(() => expect(engine.hasPendingCreate()).toBe(true))
		const closing = controller.close()
		const detached = engine.finishPendingCreate()
		await expect(pending).resolves.toMatchObject({ code: 'NOT_RUNNING' })
		await closing
		expect(detached.dispose).toHaveBeenCalledOnce()
	})

	it('reports cleanup failure from a session created during controller close', async () => {
		const owner = fakeOwner()
		const engine = new BlockingEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		engine.blockNext = true
		const pending = controller.createSession().catch((error: unknown) => error)
		await vi.waitFor(() => expect(engine.hasPendingCreate()).toBe(true))
		const closing = controller.close()
		const detached = engine.finishPendingCreate()
		const cleanupFailure = new Error('Detached SDK dispose failed')
		detached.dispose.mockImplementation(() => {
			throw cleanupFailure
		})
		await expect(pending).resolves.toBe(cleanupFailure)
		await expect(closing).rejects.toMatchObject({ errors: [cleanupFailure] })
	})

	it('reports session cleanup failures from repeated controller close calls', async () => {
		const owner = fakeOwner()
		const engine = new FakeEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const session = await controller.createSession()
		const cleanupFailure = new Error('SDK dispose failed')
		engine.created[0]!.session.dispose.mockImplementation(() => {
			throw cleanupFailure
		})
		const closing = controller.close()
		expect(controller.close()).toBe(closing)
		await expect(closing).rejects.toMatchObject({
			errors: [{ errors: [cleanupFailure] }],
		})
		await expect(controller.close()).rejects.toMatchObject({
			errors: [{ errors: [cleanupFailure] }],
		})
		await expect(session.dispose()).rejects.toMatchObject({ errors: [cleanupFailure] })
	})

	it('reports a child cleanup failure when its parent closes', async () => {
		const owner = fakeOwner()
		let releasePrompt: (() => void) | undefined
		const waiting = new Promise<void>((resolve) => {
			releasePrompt = resolve
		})
		class ChildEngine extends FakeEngine {
			override async createSession(options: PiEngineCreateOptions): Promise<AgentSession> {
				const session = await super.createSession(options)
				if (this.created.length === 2) {
					vi.spyOn(this.created[1]!.session, 'prompt').mockImplementation(async () => waiting)
				}
				return session
			}
		}
		const engine = new ChildEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const parent = await controller.createSession()
		const childRun = parent.spawnSubagent('wait').catch((error: unknown) => error)
		await vi.waitFor(() => expect(engine.created).toHaveLength(2))
		const child = engine.created[1]!.session
		const cleanupFailure = new Error('Child SDK dispose failed')
		child.dispose.mockImplementation(() => {
			throw cleanupFailure
		})
		await vi.waitFor(() => expect(child.prompt).toHaveBeenCalled())
		const closing = parent.dispose()
		releasePrompt!()
		await expect(closing).rejects.toMatchObject({
			errors: [{ errors: [cleanupFailure] }],
		})
		await childRun
		await controller.close()
	})

	it('reports cleanup failure from a child created during parent close', async () => {
		const owner = fakeOwner()
		const engine = new BlockingEngine()
		const controller = new PiAgentController(owner, engine, config, () => {})
		const parent = await controller.createSession()
		engine.blockNext = true
		const childRun = parent.spawnSubagent('wait').catch((error: unknown) => error)
		await vi.waitFor(() => expect(engine.hasPendingCreate()).toBe(true))
		const closing = parent.dispose()
		const child = engine.finishPendingCreate()
		const cleanupFailure = new Error('Late child SDK dispose failed')
		child.dispose.mockImplementation(() => {
			throw cleanupFailure
		})
		await expect(closing).rejects.toMatchObject({
			errors: [{ errors: [cleanupFailure] }],
		})
		await childRun
		await controller.close()
	})

	it('installs and executes a direct command through a real Pi SDK session', async () => {
		const owner = fakeOwner()
		const actual = await DefaultPiEngine.create()
		let sdkSession: AgentSession | undefined
		const engine: PiEngine = {
			resolveModel: (reference) => actual.resolveModel(reference),
			async createSession(options) {
				sdkSession = await actual.createSession(options)
				return sdkSession
			},
		}
		const controller = new PiAgentController(owner, engine, config, () => {})
		try {
			const session = await controller.createSession({ tools: [echoCommand] })
			const tool = sdkSession?.agent.state.tools.find(({ label }) => label === 'notes.echo')
			expect(tool).toBeDefined()
			const result = await tool!.execute('call-1', { text: 'sdk' }, undefined, () => {})
			expect(result.content).toMatchObject([{ type: 'text', text: '{"text":"sdk"}' }])
			await session.dispose()
		} finally {
			await controller.close()
		}
	})

	it('ties exposed commands to the caller Plugin generation', async () => {
		await using host = await createTestHost()
		await host.start(PiAgentPlugin)
		await host.start(NotesPublisher)
		expect(
			host
				.require(PiAgentPlugin)
				.tools()
				.map(({ name }) => name),
		).toEqual(['notes.echo'])
		await host.stop(NotesPublisher)
		expect(host.require(PiAgentPlugin).tools()).toEqual([])
	})

	it('starts as an ordinary headless Plugin without AgentTools', async () => {
		await using host = await createTestHost()
		await host.start(PiAgentPlugin)
		const agent = host.require(PiAgentPlugin)
		expect(agent.sessions()).toEqual([])
		expect(agent.tools()).toEqual([])
	})
})

function commandTool(tools: readonly ToolDefinition[]): ToolDefinition {
	const tool = tools.find(({ label }) => label !== 'Goal' && label !== 'Subagent')
	if (!tool) throw new Error('No command tool')
	return tool
}

function execute(tool: ToolDefinition, params: unknown) {
	return tool.execute('call-1', params, undefined, undefined, undefined as never)
}

function fakeOwner(root?: CoreContext): CoreContext {
	const effects = { defer: () => ({ cancel() {} }) }
	const owner: { root?: object; effects: typeof effects } = { effects }
	owner.root = root ?? owner
	return owner as unknown as CoreContext
}
