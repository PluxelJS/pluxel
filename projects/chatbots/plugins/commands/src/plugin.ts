import { CommandError, type Command, type Registration } from '@pluxel/commands'
import { createArgvRouter } from '@pluxel/commands/argv'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatAccessPlugin } from '@repo/chatbots-access'
import type { ChatPayload } from '@repo/chatbots-contracts'
import { ChatHubPlugin, type ChatHandlerContext } from '@repo/chatbots-hub'
import { runCommandMiddleware } from './middleware.ts'
import type {
	ChatCommandBinding,
	ChatCommandContext,
	ChatCommandDescriptor,
	ChatCommandMiddleware,
	ChatCommandPermission,
} from './types.ts'

type ActiveBinding = {
	registration: Registration
	permission?: ChatCommandPermission
	permissionNode?: string
	hidden: boolean
	respond?: (
		output: unknown,
		context: ChatCommandContext,
	) => ChatPayload | undefined | Promise<ChatPayload | undefined>
	disposePermission?: () => void
}

type MiddlewareEntry = {
	priority: number
	middleware: ChatCommandMiddleware
}

/** @internal ChatHub owns parsing and constructs the context required by its command registry. */
export class ChatCommandCarrier {
	private readonly router = createArgvRouter<ChatCommandContext>()
	private readonly bindings = new Map<string, ActiveBinding>()
	private readonly middlewares = new Map<string, MiddlewareEntry>()
	private middlewarePlan?: readonly ChatCommandMiddleware[]
	private active = true

	constructor(
		private readonly access: Pick<ChatAccessPlugin, 'resolveMessage' | 'declare' | 'authorize'>,
		private readonly logger: {
			warn(message: string, data?: Record<string, unknown>): void
		},
	) {}

	register<Input, Output>(
		command: Command<Input, Output, ChatCommandContext>,
		binding: ChatCommandBinding<Input, Output>,
	): Registration {
		this.assertActive()
		const { permission, hidden = false, respond, ...argv } = binding
		const registration = this.router.bind(command, argv)
		const permissionSnapshot = snapshotPermission(permission)
		const permissionNode =
			permissionSnapshot === false
				? undefined
				: resolvePermissionNode(command.name, permissionSnapshot)
		let disposePermission: (() => void) | undefined

		try {
			if (permissionNode) {
				const config = typeof permissionSnapshot === 'object' ? permissionSnapshot : undefined
				disposePermission = this.access.declare({
					node: permissionNode,
					description: command.descriptor.description,
					defaultEffect: config?.defaultEffect ?? 'deny',
				})
			}
		} catch (error) {
			registration.dispose()
			throw error
		}

		const active: ActiveBinding = {
			registration,
			...(permissionSnapshot === undefined ? {} : { permission: permissionSnapshot }),
			...(permissionNode ? { permissionNode } : {}),
			hidden,
			...(respond
				? {
						respond: respond as (
							output: unknown,
							context: ChatCommandContext,
						) => ChatPayload | undefined | Promise<ChatPayload | undefined>,
					}
				: {}),
			...(disposePermission ? { disposePermission } : {}),
		}
		this.bindings.set(command.name, active)

		return Object.freeze({
			name: command.name,
			dispose: () => this.remove(command.name, active),
		})
	}

	registerMiddleware(id: string, middleware: ChatCommandMiddleware, priority = 100): Registration {
		this.assertActive()
		if (this.middlewares.has(id)) throw new Error(`Command middleware already registered: ${id}`)
		const entry = { priority, middleware }
		this.middlewares.set(id, entry)
		this.middlewarePlan = undefined
		return Object.freeze({
			name: id,
			dispose: () => {
				if (this.middlewares.get(id) !== entry) return
				this.middlewares.delete(id)
				this.middlewarePlan = undefined
			},
		})
	}

	list(): readonly ChatCommandDescriptor[] {
		return Object.freeze(
			this.router.list().map((descriptor) => {
				const binding = this.bindings.get(descriptor.name)!
				return Object.freeze({
					...descriptor,
					hidden: binding.hidden,
					...(binding.permission === undefined ? {} : { permission: binding.permission }),
				})
			}),
		)
	}

	async dispatch(context: ChatHandlerContext): Promise<'stop' | void> {
		const source = commandSource(context)
		if (source === undefined) return
		let commandName: string | undefined

		try {
			const resolution = this.router.resolve(source)
			if (!resolution) return
			commandName = resolution.command.name
			// Capture the projection before executing so disposal cannot change an in-flight invocation.
			const binding = this.bindings.get(commandName)!
			const commandContext: ChatCommandContext = Object.freeze({
				...context,
				user: this.access.resolveMessage(context.message),
			})

			if (
				binding.permissionNode &&
				!this.access.authorize(commandContext.user.id, binding.permissionNode)
			) {
				await context.reply('没有权限执行此命令。')
				return 'stop'
			}

			const output = await runCommandMiddleware(commandContext, this.getMiddlewarePlan(), () =>
				resolution.command.executeOrThrow(resolution.candidate, commandContext),
			)
			const payload = await binding.respond?.(output, commandContext)
			if (payload !== undefined) await context.reply(payload)
		} catch (error) {
			if (context.signal.aborted) throw context.signal.reason ?? error
			await this.reportFailure(error, context, commandName)
		}
		return 'stop'
	}

	dispose(): void {
		if (!this.active) return
		this.active = false
		for (const [name, binding] of this.bindings) this.remove(name, binding)
		this.middlewares.clear()
		this.middlewarePlan = undefined
	}

	private remove(name: string, expected: ActiveBinding): void {
		if (this.bindings.get(name) !== expected) return
		this.bindings.delete(name)
		expected.registration.dispose()
		expected.disposePermission?.()
	}

	private getMiddlewarePlan(): readonly ChatCommandMiddleware[] {
		return (this.middlewarePlan ??= [...this.middlewares.values()]
			.sort((left, right) => left.priority - right.priority)
			.map((entry) => entry.middleware))
	}

	private async reportFailure(
		error: unknown,
		context: ChatHandlerContext,
		command: string | undefined,
	): Promise<void> {
		if (error instanceof CommandError && error.kind === 'expected') {
			await context.reply(error.publicMessage)
			return
		}
		this.logger.warn('Chat command failed', { command, error })
		await context.reply('命令执行失败，请稍后重试。')
	}

	private assertActive(): void {
		if (!this.active) throw new Error('Chat command carrier is stopped')
	}
}

@Plugin({ name: 'ChatCommandsPlugin' })
export class ChatCommandsPlugin extends BasePlugin {
	private carrier!: ChatCommandCarrier

	constructor(
		private readonly hub: ChatHubPlugin,
		private readonly access: ChatAccessPlugin,
	) {
		super()
	}

	override init(): void {
		this.carrier = new ChatCommandCarrier(this.access, this.ctx.logger)
		this.ctx.effects.own(this.carrier, { tag: 'ChatCommands' })
		this.ctx.effects.defer(
			this.hub.registerHandler({
				id: 'chatbots.commands',
				priority: 10,
				handle: (context) => this.carrier.dispatch(context),
			}),
		)
	}

	register<Input, Output>(
		command: Command<Input, Output, ChatCommandContext>,
		binding: ChatCommandBinding<Input, Output>,
	): Registration {
		return this.ready().register(command, binding)
	}

	registerMiddleware(id: string, middleware: ChatCommandMiddleware, priority = 100): Registration {
		return this.ready().registerMiddleware(id, middleware, priority)
	}

	list(): readonly ChatCommandDescriptor[] {
		return this.ready().list()
	}

	private ready(): ChatCommandCarrier {
		if (!this.carrier) throw new Error('ChatCommandsPlugin is not running')
		return this.carrier
	}
}

function resolvePermissionNode(
	name: string,
	permission: ChatCommandPermission | undefined,
): string {
	if (typeof permission === 'string') return permission
	if (permission && typeof permission === 'object' && permission.node) return permission.node
	return `cmd.${name}`
}

function snapshotPermission(
	permission: ChatCommandPermission | undefined,
): ChatCommandPermission | undefined {
	return permission && typeof permission === 'object'
		? Object.freeze({ ...permission })
		: permission
}

function commandSource(context: ChatHandlerContext): string | undefined {
	const text = context.message.text.trimStart()
	if (!text.startsWith('/')) return undefined
	const source = text.slice(1).trim()
	if (!source) return undefined
	// Telegram may qualify the first route token as `/help@botname`.
	return source.replace(/^([^\s@]+)@[^\s]+/, '$1')
}
