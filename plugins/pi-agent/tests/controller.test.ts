import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import type {
	AgentSession,
	AgentSessionEvent,
	ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import type { PiAgentPluginConfig } from '../src/config.ts'
import { PiAgentController } from '../src/controller.ts'
import type { PiEngine, PiEngineCreateOptions, ResolvedPiModel } from '../src/engine.ts'
import { PiAgentPlugin } from '../src/index.ts'

const echoCommand = defineCommand({
	name: 'notes.echo',
	description: 'Echo one note.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({ text: Type.String() }),
	output: obj({ text: Type.String() }),
	execute: ({ text }) => ({ text }),
})

@Plugin()
class NotesPlugin extends BasePlugin {
	protected override init(): void {
		this.ctx.commands.register(echoCommand)
	}
}

const policy = {
	toolsets: [{ id: 'notes', label: 'Notes', commandNames: ['notes.echo'] }],
	agents: [{ agentId: 'assistant', label: 'Assistant', toolsetIds: ['notes'] }],
} as const

const config: PiAgentPluginConfig = {
	defaultToolSetupId: 'assistant',
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

describe('PiAgentController', () => {
	it('starts and stops as an ordinary headless Plugin with AgentTools as a required dependency', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, PiAgentPlugin])
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(PiAgentPlugin)
			await host.commit()
			expect(host.isRunning(AgentToolsPlugin)).toBe(true)
			expect(host.isRunning(PiAgentPlugin)).toBe(true)
			expect(host.require(PiAgentPlugin).sessions()).toEqual([])
		} finally {
			await host.dispose()
		}
	})

	it('projects only the bound AgentTools catalog and dispatches through it', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, NotesPlugin])
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin).start(NotesPlugin)
			await host.commit()
			const engine = new FakeEngine()
			const controller = new PiAgentController(
				host.require(AgentToolsPlugin),
				engine,
				config,
				() => {},
			)

			const session = await controller.createSession({ id: 'main' })
			const definitions = engine.created[0].options.tools
			expect(definitions.map(({ name }) => name)).toEqual(
				expect.arrayContaining(['pluxel_goal', 'pluxel_subagent']),
			)
			expect(definitions.map(({ name }) => name)).not.toContain('read')
			expect(definitions.map(({ name }) => name)).not.toContain('bash')
			const command = definitions.find(({ description }) => description.includes('notes.echo'))
			expect(command?.name).toMatch(/^pluxel_cmd_notes_echo_/)
			await expect(execute(command!, { text: 'hello' })).resolves.toMatchObject({
				content: [{ text: '{"text":"hello"}' }],
			})
			expect(session.snapshot().availableCommandNames).toEqual(['notes.echo'])

			await controller.close()
			expect(engine.created[0].session.abort).toHaveBeenCalled()
			expect(engine.created[0].session.waitForIdle).toHaveBeenCalled()
			expect(engine.created[0].session.dispose).toHaveBeenCalledOnce()
		} finally {
			await host.dispose()
		}
	})

	it('atomically refreshes Pi tools when the bound command catalog changes', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, NotesPlugin])
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin)
			await host.commit()
			const engine = new FakeEngine()
			const controller = new PiAgentController(
				host.require(AgentToolsPlugin),
				engine,
				config,
				() => {},
			)

			const session = await controller.createSession({ id: 'main' })
			expect(session.snapshot().availableCommandNames).toEqual([])
			expect(
				engine.created[0].session.agent.state.tools.some(({ description }) =>
					description.includes('notes.echo'),
				),
			).toBe(false)

			host.start(NotesPlugin)
			await host.commit()
			expect(session.snapshot().availableCommandNames).toEqual(['notes.echo'])
			expect(
				engine.created[0].session.agent.state.tools.some(({ description }) =>
					description.includes('notes.echo'),
				),
			).toBe(true)
			await controller.close()
		} finally {
			await host.dispose()
		}
	})

	it('disposes active sessions while an in-flight session creation settles', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(AgentToolsPlugin)
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin)
			await host.commit()
			const engine = new BlockingEngine()
			const controller = new PiAgentController(
				host.require(AgentToolsPlugin),
				engine,
				config,
				() => {},
			)

			await controller.createSession({ id: 'active' })
			engine.blockNext = true
			const pending = controller.createSession({ id: 'pending' }).then(
				(): undefined => undefined,
				(error: unknown) => error,
			)
			await vi.waitFor(() => expect(engine.hasPendingCreate()).toBe(true))

			const closing = controller.close()
			await vi.waitFor(() => expect(engine.created[0].session.abort).toHaveBeenCalled())
			const detached = engine.finishPendingCreate()

			await expect(pending).resolves.toMatchObject({ code: 'NOT_RUNNING' })
			await closing
			expect(detached.dispose).toHaveBeenCalledOnce()
		} finally {
			await host.dispose()
		}
	})

	it('keeps real goal state and runs bounded subagents with the inherited setup', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add([AgentToolsPlugin, NotesPlugin])
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin).start(NotesPlugin)
			await host.commit()
			const engine = new FakeEngine()
			const controller = new PiAgentController(
				host.require(AgentToolsPlugin),
				engine,
				config,
				() => {},
			)

			const session = await controller.createSession({ id: 'main' })
			session.setGoal('Ship the integration')
			expect(session.snapshot().goal).toMatchObject({
				text: 'Ship the integration',
				status: 'active',
			})
			const child = await session.spawnSubagent('Review lifecycle ownership')
			expect(child).toEqual({
				ok: true,
				id: expect.any(String),
				text: 'completed: Review lifecycle ownership',
			})
			expect(engine.created).toHaveLength(2)
			expect(
				engine.created[1].options.tools.some(({ description }) =>
					description.includes('notes.echo'),
				),
			).toBe(true)
			expect(session.snapshot().subagents).toMatchObject([
				{ task: 'Review lifecycle ownership', status: 'completed' },
			])
			expect(engine.created[1].session.dispose).toHaveBeenCalledOnce()

			const abort = new AbortController()
			abort.abort()
			await expect(
				session.spawnSubagent('Cancelled before admission', { signal: abort.signal }),
			).rejects.toMatchObject({ code: 'ABORTED' })
			expect(session.snapshot().subagents.at(-1)).toMatchObject({ status: 'aborted' })

			session.completeGoal('Reviewed and ready')
			expect(session.snapshot().goal).toMatchObject({
				status: 'completed',
				summary: 'Reviewed and ready',
			})
			await controller.close()
		} finally {
			await host.dispose()
		}
	})

	it('rejects unknown tool setup ids instead of creating an empty accidental session', async () => {
		const host = createRuntimeHost({ workbench: false })
		try {
			host.add(AgentToolsPlugin)
			host.cfg(AgentToolsPlugin).set(policy)
			host.start(AgentToolsPlugin)
			await host.commit()
			const controller = new PiAgentController(
				host.require(AgentToolsPlugin),
				new FakeEngine(),
				config,
				() => {},
			)

			await expect(controller.createSession({ toolSetupId: 'missing' })).rejects.toMatchObject({
				code: 'TOOL_SETUP_NOT_FOUND',
			})
			await controller.close()
		} finally {
			await host.dispose()
		}
	})
})

function execute(tool: ToolDefinition, params: unknown) {
	return tool.execute('call-1', params, undefined, undefined, undefined as never)
}
