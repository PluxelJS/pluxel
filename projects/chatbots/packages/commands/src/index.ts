import { BasePlugin, Plugin } from '@pluxel/runtime'
import { ChatHubPlugin, type ChatContent, type ChatHandlerContext } from '@repo/chatbots-hub'

export type ChatCommandContext = ChatHandlerContext & {
	args: readonly string[]
	rawArgs: string
}

export type ChatCommand = {
	name: string
	description: string
	aliases?: readonly string[]
	execute(context: ChatCommandContext): ChatContent | void | Promise<ChatContent | void>
}

export type RegisteredChatCommand = Pick<ChatCommand, 'name' | 'description' | 'aliases'>

function tokenize(input: string): string[] {
	const tokens: string[] = []
	let token = ''
	let quote = ''
	let escaped = false
	for (const char of input.trim()) {
		if (escaped) {
			token += char
			escaped = false
			continue
		}
		if (char === '\\') {
			escaped = true
			continue
		}
		if (quote) {
			if (char === quote) quote = ''
			else token += char
			continue
		}
		if (char === '"' || char === "'") {
			quote = char
			continue
		}
		if (/\s/.test(char)) {
			if (token) {
				tokens.push(token)
				token = ''
			}
			continue
		}
		token += char
	}
	if (escaped) token += '\\'
	if (token) tokens.push(token)
	return tokens
}

export class CommandRegistry {
	private readonly commands = new Map<string, ChatCommand>()
	private readonly aliases = new Map<string, string>()

	register(command: ChatCommand): () => void {
		const name = command.name.trim().toLowerCase()
		if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
			throw new Error(`Invalid command name: ${command.name}`)
		const keys = [name, ...(command.aliases ?? []).map((alias) => alias.trim().toLowerCase())]
		for (const key of keys)
			if (this.commands.has(key) || this.aliases.has(key))
				throw new Error(`Command trigger already registered: ${key}`)
		const registered = { ...command, name }
		this.commands.set(name, registered)
		for (const alias of keys.slice(1)) this.aliases.set(alias, name)
		return () => {
			if (this.commands.get(name) !== registered) return
			this.commands.delete(name)
			for (const alias of keys.slice(1))
				if (this.aliases.get(alias) === name) this.aliases.delete(alias)
		}
	}

	list(): RegisteredChatCommand[] {
		return [...this.commands.values()]
			.map(({ name, description, aliases }) => ({ name, description, aliases }))
			.sort((a, b) => a.name.localeCompare(b.name))
	}

	resolve(name: string): ChatCommand | undefined {
		const key = name.toLowerCase()
		return this.commands.get(this.aliases.get(key) ?? key)
	}
}

@Plugin({ name: 'ChatCommandsPlugin' })
export class ChatCommandsPlugin extends BasePlugin {
	private registry!: CommandRegistry

	constructor(private readonly hub: ChatHubPlugin) {
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
		return this.ready().register(command)
	}
	list(): RegisteredChatCommand[] {
		return this.ready().list()
	}

	private async dispatch(context: ChatHandlerContext): Promise<'stop' | void> {
		const prefix = '/'
		if (!prefix || !context.message.text.startsWith(prefix)) return
		const input = context.message.text.slice(prefix.length).trim()
		const tokens = tokenize(input)
		if (tokens.length === 0) return
		const command = this.ready().resolve(tokens[0]!.replace(/@[^\s]+$/, ''))
		if (!command) return
		const rawArgs = input.slice(tokens[0]!.length).trim()
		const output = await command.execute({ ...context, args: tokens.slice(1), rawArgs })
		if (output !== undefined) await context.reply(output as ChatContent)
		return 'stop'
	}

	private ready(): CommandRegistry {
		if (!this.registry) throw new Error('ChatCommandsPlugin is not running')
		return this.registry
	}
}

export { tokenize as tokenizeCommand }
