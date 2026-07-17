import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatAccessPlugin } from '@repo/chatbots-access'
import type { ChatPayload } from '@repo/chatbots-contracts'
import { ChatHubPlugin, type ChatHandlerContext } from '@repo/chatbots-hub'
import { normalizeRoute, parseCommandLine } from './parser.ts'
import { runCommandMiddleware } from './middleware.ts'
import { CommandRegistry } from './registry.ts'
import {
	ChatCommandError,
	type ChatCommand,
	type ChatCommandContext,
	type ChatCommandMiddleware,
	type ParsedCommandLine,
	type RegisteredChatCommand,
} from './types.ts'

@Plugin({ name: 'ChatCommandsPlugin' })
export class ChatCommandsPlugin extends BasePlugin {
	private registry!: CommandRegistry
	private readonly middlewares = new Map<
		string,
		{ priority: number; middleware: ChatCommandMiddleware }
	>()
	private middlewarePlan?: readonly ChatCommandMiddleware[]

	constructor(
		private readonly hub: ChatHubPlugin,
		private readonly access: ChatAccessPlugin,
	) {
		super()
	}

	override init(): void {
		this.registry = new CommandRegistry()
		const dispose = this.hub.registerHandler({
			id: 'chatbots.commands',
			priority: 10,
			handle: (context) => this.dispatch(context),
		})
		this.ctx.effects.defer(dispose)
	}

	register(command: ChatCommand): () => void {
		const disposeCommand = this.ready().register(command)
		const normalizedName = normalizeRoute(command.name)
		let disposePermission: (() => void) | undefined
		try {
			if (command.permission !== false) {
				const config = typeof command.permission === 'object' ? command.permission : undefined
				const node =
					typeof command.permission === 'string'
						? command.permission
						: (config?.node ?? `cmd.${normalizedName.replaceAll(' ', '.')}`)
				disposePermission = this.access.declare({
					node,
					description: command.description,
					defaultEffect: config?.defaultEffect ?? 'deny',
				})
			}
		} catch (error) {
			disposeCommand()
			throw error
		}
		let active = true
		return () => {
			if (!active) return
			active = false
			disposeCommand()
			disposePermission?.()
		}
	}

	registerMiddleware(id: string, middleware: ChatCommandMiddleware, priority = 100): () => void {
		if (this.middlewares.has(id)) throw new Error(`Command middleware already registered: ${id}`)
		const value = { priority, middleware }
		this.middlewares.set(id, value)
		this.middlewarePlan = undefined
		return () => {
			if (this.middlewares.get(id) === value) {
				this.middlewares.delete(id)
				this.middlewarePlan = undefined
			}
		}
	}

	list(): RegisteredChatCommand[] {
		return this.ready().list()
	}

	private async dispatch(context: ChatHandlerContext): Promise<'stop' | void> {
		if (!context.message.text.startsWith('/')) return
		const input = context.message.text.slice(1).trim()
		let parsed: ParsedCommandLine
		try {
			parsed = parseCommandLine(input)
		} catch (error) {
			if (error instanceof ChatCommandError) {
				await context.reply(error.message)
				return 'stop'
			}
			throw error
		}
		if (parsed.tokens.length === 0) return
		const resolved = this.ready().resolve(parsed.tokens)
		if (!resolved) return
		const { command, consumed } = resolved
		const user = this.access.resolveMessage(context.message)
		const permission = command.permission
		if (permission !== false) {
			const node =
				typeof permission === 'string'
					? permission
					: typeof permission === 'object' && permission.node
						? permission.node
						: `cmd.${command.name.replaceAll(' ', '.')}`
			if (!this.access.authorize(user.id, node)) {
				await context.reply('没有权限执行此命令。')
				return 'stop'
			}
		}
		const rawArgs = input.slice(parsed.tokenSpans[consumed - 1]!.end).trimStart()
		const commandContext: ChatCommandContext = {
			...context,
			user,
			args: parsed.positionals.slice(consumed),
			rawArgs,
			flags: parsed.flags,
		}
		const chain = this.getMiddlewarePlan()
		try {
			const output = await runCommandMiddleware(commandContext, chain, () =>
				command.execute(commandContext),
			)
			if (output !== undefined) await context.reply(output as ChatPayload)
		} catch (error) {
			if (error instanceof ChatCommandError) await context.reply(error.message)
			else {
				this.ctx.logger.warn('Chat command failed', { command: command.name, error })
				await context.reply('命令执行失败，请稍后重试。')
			}
		}
		return 'stop'
	}

	private ready(): CommandRegistry {
		if (!this.registry) throw new Error('ChatCommandsPlugin is not running')
		return this.registry
	}

	private getMiddlewarePlan(): readonly ChatCommandMiddleware[] {
		return (this.middlewarePlan ??= [...this.middlewares.values()]
			.sort((a, b) => a.priority - b.priority)
			.map((item) => item.middleware))
	}
}
