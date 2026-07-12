import { normalizeRoute } from './parser.ts'
import type { ChatCommand, RegisteredChatCommand, RegisteredCommand } from './types.ts'

export class CommandRegistry {
	private readonly commands = new Map<string, RegisteredCommand>()
	private readonly aliases = new Map<string, string>()

	register(command: ChatCommand): () => void {
		const name = normalizeRoute(command.name)
		const aliases = (command.aliases ?? []).map(normalizeRoute)
		for (const key of [name, ...aliases])
			if (this.commands.has(key) || this.aliases.has(key))
				throw new Error(`Command trigger already registered: ${key}`)
		const registered: RegisteredCommand = { ...command, name, route: name.split(' ') }
		this.commands.set(name, registered)
		for (const alias of aliases) this.aliases.set(alias, name)
		return () => {
			if (this.commands.get(name) !== registered) return
			this.commands.delete(name)
			for (const alias of aliases) if (this.aliases.get(alias) === name) this.aliases.delete(alias)
		}
	}

	list(): RegisteredChatCommand[] {
		return [...this.commands.values()]
			.map(({ name, title, description, usage, aliases, hidden, permission }) => ({
				name,
				title,
				description,
				usage,
				aliases,
				hidden,
				permission,
			}))
			.sort((a, b) => a.name.localeCompare(b.name))
	}

	resolve(tokens: readonly string[]): { command: RegisteredCommand; consumed: number } | undefined {
		let route = ''
		let resolved: { command: RegisteredCommand; consumed: number } | undefined
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]!.toLowerCase().replace(/@[^\s]+$/, '')
			route += `${index ? ' ' : ''}${token}`
			const command = this.commands.get(this.aliases.get(route) ?? route)
			if (command) resolved = { command, consumed: index + 1 }
		}
		return resolved
	}
}
