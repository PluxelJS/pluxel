import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { PiAgentConfig } from './config.ts'
import { PiAgentController } from './controller.ts'
import { DefaultPiEngine } from './engine.ts'
import { PiAgentError } from './errors.ts'
import type {
	CreatePiAgentSessionOptions,
	PiAgentSession,
	PiAgentSessionSnapshot,
} from './types.ts'

@Plugin({ displayName: 'Pi Agent' })
export class PiAgentPlugin extends BasePlugin {
	private readonly config = this.configs.use(PiAgentConfig)
	private controller?: PiAgentController

	constructor(private readonly agentTools: AgentToolsPlugin) {
		super()
	}

	protected override async init(): Promise<() => Promise<void>> {
		const engine = await DefaultPiEngine.create()
		const controller = new PiAgentController(this.agentTools, engine, this.config, (error) =>
			this.ctx.logger.error('Pi Agent listener failed', { error }),
		)
		this.controller = controller
		this.configs.onUpdate(this.config, ({ desired }) => controller.update(desired))
		return async () => {
			if (this.controller === controller) this.controller = undefined
			await controller.close()
		}
	}

	createSession(options: CreatePiAgentSessionOptions = {}): Promise<PiAgentSession> {
		return this.requireController().createSession(options)
	}

	sessions(): readonly PiAgentSessionSnapshot[] {
		return this.requireController().sessions()
	}

	session(id: string): PiAgentSession | undefined {
		return this.requireController().session(id)
	}

	private requireController(): PiAgentController {
		if (!this.controller) throw new PiAgentError('NOT_RUNNING', 'PiAgentPlugin is not running')
		return this.controller
	}
}

export { PiAgentConfig } from './config.ts'
export type { PiAgentPluginConfig } from './config.ts'
export { PiAgentError } from './errors.ts'
export type { PiAgentErrorCode } from './errors.ts'
export type {
	CreatePiAgentSessionOptions,
	PiAgentPromptOptions,
	PiAgentRunResult,
	PiAgentSession,
	PiAgentSessionEvent,
	PiAgentSessionSnapshot,
	PiAgentSessionState,
	PiGoalSnapshot,
	PiModelReference,
	PiSubagentOptions,
	PiSubagentRunResult,
	PiSubagentSnapshot,
} from './types.ts'
