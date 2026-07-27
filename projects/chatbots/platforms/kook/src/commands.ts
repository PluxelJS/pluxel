import {
	CommandError,
	type Command,
	type CommandContext,
	type Registration,
} from '@pluxel/commands'
import {
	createArgvRouter,
	type ArgvBinding,
	type ArgvCommandDescriptor,
} from '@pluxel/commands/argv'
import type { Context } from '@pluxel/runtime'
import type { KookBot } from './bot/bot.ts'
import type { KookEvent } from './bot/events.types.ts'
import { MessageType } from './types/base.ts'

export interface KookCommandContext extends CommandContext {
	readonly carrier: 'kook'
	readonly signal: AbortSignal
	readonly bot: KookBot
	readonly event: KookEvent
	/** Reply to the message that invoked this command and return the created KOOK message ID. */
	reply(content: string): Promise<string>
}

export type KookCommandBinding<Input, Output> = ArgvBinding<Input> & {
	/** Project a validated command result back to KOOK. Omit when the handler replies itself. */
	respond?: (output: Output, context: KookCommandContext) => void | Promise<void>
}

export interface KookCommands {
	register<Input, Output>(
		command: Command<Input, Output, KookCommandContext>,
		binding: KookCommandBinding<Input, Output>,
	): Registration
	list(): readonly ArgvCommandDescriptor[]
}

type ActiveBinding = {
	registration: Registration
	respond?: (output: unknown, context: KookCommandContext) => void | Promise<void>
}

/** @internal KOOK owns parsing and constructs the context required by its command registry. */
export class KookCommandCarrier implements KookCommands {
	private readonly router = createArgvRouter<KookCommandContext>()
	private readonly bindings = new Map<string, ActiveBinding>()
	private active = true

	constructor(private readonly ctx: Context) {}

	register<Input, Output>(
		command: Command<Input, Output, KookCommandContext>,
		binding: KookCommandBinding<Input, Output>,
	): Registration {
		this.assertActive()
		const { respond, ...argv } = binding
		const registration = this.router.bind(command, argv)
		const active: ActiveBinding = {
			registration,
			...(respond
				? {
						respond: respond as (
							output: unknown,
							context: KookCommandContext,
						) => void | Promise<void>,
					}
				: {}),
		}
		this.bindings.set(command.name, active)
		return Object.freeze({
			name: command.name,
			dispose: () => this.remove(command.name, active),
		})
	}

	list(): readonly ArgvCommandDescriptor[] {
		return this.router.list()
	}

	async dispatch(bot: KookBot, event: KookEvent, signal: AbortSignal): Promise<boolean> {
		const source = commandSource(bot, event)
		if (source === undefined) return false
		const context = createKookCommandContext(bot, event, signal)
		let commandName: string | undefined

		try {
			const resolution = this.router.resolve(source)
			if (!resolution) return false
			commandName = resolution.command.name
			const binding = this.bindings.get(commandName)
			const output = await resolution.command.executeOrThrow(resolution.candidate, context)
			await binding?.respond?.(output, context)
			return true
		} catch (error) {
			if (signal.aborted) throw signal.reason
			await this.reportFailure(error, context, commandName)
			return true
		}
	}

	dispose(): void {
		if (!this.active) return
		this.active = false
		for (const [name, binding] of this.bindings) this.remove(name, binding)
	}

	private remove(name: string, expected: ActiveBinding): void {
		if (this.bindings.get(name) !== expected) return
		this.bindings.delete(name)
		expected.registration.dispose()
	}

	private async reportFailure(
		error: unknown,
		context: KookCommandContext,
		command: string | undefined,
	): Promise<void> {
		if (error instanceof CommandError && error.kind === 'expected') {
			await context.reply(error.publicMessage)
			return
		}
		this.ctx.logger.warn('KOOK command failed', {
			command,
			accountId: context.bot.id,
			error,
		})
		await context.reply('命令执行失败，请稍后重试。')
	}

	private assertActive(): void {
		if (!this.active) throw new Error('KOOK command carrier is stopped')
	}
}

function commandSource(bot: KookBot, event: KookEvent): string | undefined {
	if (event.type !== MessageType.text && event.type !== MessageType.kmarkdown) return undefined
	if (event.author_id === bot.selfInfo?.id || event.extra?.author?.bot) return undefined
	const text = (event.extra?.kmarkdown?.raw_content ?? event.content ?? '').trimStart()
	if (!text.startsWith('/')) return undefined
	const source = text.slice(1).trim()
	return source || undefined
}

function createKookCommandContext(
	bot: KookBot,
	event: KookEvent,
	signal: AbortSignal,
): KookCommandContext {
	return Object.freeze({
		carrier: 'kook' as const,
		signal,
		bot,
		event,
		reply: async (content: string) => {
			const result =
				event.channel_type === 'PERSON'
					? await bot.$.direct({ target_id: event.author_id }).reply(event.msg_id, content)
					: await bot.$.channel(event.target_id).reply(event.msg_id, content)
			if (result.ok === false) {
				throw new Error(`KOOK API error ${result.code}: ${result.message}`)
			}
			return result.data.msg_id
		},
	})
}
