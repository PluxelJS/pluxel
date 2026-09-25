import type { CommandContext, DirectCommand } from '@pluxel/commands'
import { BasePlugin, Plugin } from '@pluxel/core'
import { PiAgentConfig } from './config.ts'
import { PiAgentController } from './controller.ts'
import { DefaultPiEngine } from './engine.ts'
import { PiAgentError } from './errors.ts'
import type {
	CreatePiAgentSessionOptions,
	PiToolChoice,
	PiToolDescriptor,
	PiToolExposure,
	PiExposureOptions,
	PiAgentSession,
	PiAgentSessionSnapshot,
} from './types.ts'

@Plugin({ displayName: 'Pi Agent' })
export class PiAgentPlugin extends BasePlugin {
	private readonly config = this.configs.use(PiAgentConfig)
	private controller?: PiAgentController

	protected override async init(): Promise<() => Promise<void>> {
		const engine = await DefaultPiEngine.create()
		const controller = new PiAgentController(this.ctx, engine, this.config, (error) =>
			this.ctx.logger.error('Pi Agent listener failed', { error }),
		)
		this.controller = controller
		this.configs.onUpdate(this.config, ({ desired }) => controller.update(desired))
		return async () => {
			if (this.controller === controller) this.controller = undefined
			await controller.close()
		}
	}

	createSession<const Tools extends readonly PiToolChoice[]>(
		options: CreatePiAgentSessionOptions<Tools>,
	): Promise<PiAgentSession>
	createSession(options?: CreatePiAgentSessionOptions<readonly []>): Promise<PiAgentSession>
	createSession(options: CreatePiAgentSessionOptions = {}): Promise<PiAgentSession> {
		return this.requireController().createSession(options, this.ctx.caller ?? this.ctx)
	}

	expose<I, O>(
		command: DirectCommand<I, O, CommandContext>,
		options?: PiExposureOptions<CommandContext>,
	): PiToolExposure
	expose<I, O, Ctx extends CommandContext>(
		command: DirectCommand<I, O, Ctx>,
		options: PiExposureOptions<NoInfer<Ctx>>,
	): PiToolExposure
	expose(
		command: DirectCommand<any, unknown, any>,
		options: PiExposureOptions<any> = {},
	): PiToolExposure {
		return this.requireController().expose(this.ctx.caller ?? this.ctx, command, options)
	}

	tools(): readonly PiToolDescriptor[] {
		return this.requireController().tools()
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
	PiToolChoice,
	PiToolDescriptor,
	PiToolExposure,
	PiExposureOptions,
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
