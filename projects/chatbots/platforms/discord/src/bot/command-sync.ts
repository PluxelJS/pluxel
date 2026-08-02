import type {
	ApplicationCommandManager,
	GuildApplicationCommandManager,
	RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js'
import type { BotAccountKv } from '@repo/chatbots-platform-kit/account-store'

export type DiscordRemoteCommand = Readonly<{
	id: string
	name: string
	toJSON(): unknown
}>

export interface DiscordCommandManager {
	fetch(): Promise<ReadonlyMap<string, DiscordRemoteCommand>>
	create(definition: RESTPostAPIChatInputApplicationCommandsJSONBody): Promise<unknown>
	edit(id: string, definition: RESTPostAPIChatInputApplicationCommandsJSONBody): Promise<unknown>
	delete(id: string): Promise<unknown>
}

export function discordCommandManager(
	manager: ApplicationCommandManager | GuildApplicationCommandManager,
): DiscordCommandManager {
	return {
		fetch: () => manager.fetch({}),
		create: (definition) => manager.create(definition),
		edit: (id, definition) => manager.edit(id, definition),
		delete: (id) => manager.delete(id),
	}
}

const MANAGED_ROOTS_PREFIX = 'commands.managed-roots.v1.'

/** Persists carrier-owned root names so a disabled plugin can withdraw commands after restart. */
export class DiscordManagedCommandStore {
	constructor(private readonly kv: BotAccountKv) {}

	async read(botId: string): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
		const value = await this.kv.get<unknown>(this.key(botId))
		if (value === undefined) return new Map()
		if (!Array.isArray(value) || value.some((item) => !isStoredTarget(item))) {
			throw new Error('Invalid Discord managed command root state')
		}
		return new Map(value.map(({ target, roots }) => [target, new Set(roots)]))
	}

	async write(botId: string, targets: ReadonlyMap<string, ReadonlySet<string>>): Promise<void> {
		await this.kv.set(
			this.key(botId),
			[...targets]
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([target, roots]) => ({ target, roots: [...roots].toSorted() })),
		)
	}

	async delete(botId: string): Promise<void> {
		await this.kv.delete(this.key(botId))
	}

	private key(botId: string): string {
		return `${MANAGED_ROOTS_PREFIX}${botId}`
	}
}

/** Upserts the current catalog and deletes only roots previously owned by this carrier. */
export async function reconcileDiscordCommands(
	manager: DiscordCommandManager,
	definitions: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[],
	previouslyManagedRoots: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
	const remote = await manager.fetch()
	const byName = new Map([...remote.values()].map((command) => [command.name, command]))
	const currentRoots = new Set(definitions.map((definition) => definition.name))
	for (const definition of definitions) {
		const existing = byName.get(definition.name)
		if (!existing) await manager.create(definition)
		else if (!sameDefinition(existing, definition)) await manager.edit(existing.id, definition)
	}
	for (const name of previouslyManagedRoots) {
		if (currentRoots.has(name)) continue
		const existing = byName.get(name)
		if (existing) await manager.delete(existing.id)
	}
	return currentRoots
}

function sameDefinition(
	remote: DiscordRemoteCommand,
	target: RESTPostAPIChatInputApplicationCommandsJSONBody,
): boolean {
	const raw = remote.toJSON()
	const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
	return (
		stableJson({
			name: value.name,
			description: value.description,
			options: value.options ?? [],
		}) ===
		stableJson({
			name: target.name,
			description: target.description,
			options: target.options ?? [],
		})
	)
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
	if (value && typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

function isCommandName(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/.test(value)
}

function isStoredTarget(value: unknown): value is { target: string; roots: string[] } {
	if (!value || typeof value !== 'object') return false
	const candidate = value as { target?: unknown; roots?: unknown }
	return (
		((typeof candidate.target === 'string' && candidate.target === 'global') ||
			(typeof candidate.target === 'string' && /^guild:\d{17,20}$/.test(candidate.target))) &&
		Array.isArray(candidate.roots) &&
		candidate.roots.every(isCommandName)
	)
}
