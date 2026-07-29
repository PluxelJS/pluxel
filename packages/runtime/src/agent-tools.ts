import type {
	AnyCommand,
	CommandBehavior,
	CommandContext,
	CommandDescriptor,
	CommandResult,
} from '@pluxel/commands'

export type CommandToolset = Readonly<{
	id: string
	label: string
	description?: string
	commandNames: readonly string[]
}>

export type AgentToolAssignment = Readonly<{
	agentId: string
	label: string
	toolsetIds: readonly string[]
}>

export type AgentToolsPolicyInput = {
	toolsets: readonly CommandToolset[]
	agents: readonly AgentToolAssignment[]
}

export type AgentToolsPolicy = Readonly<{
	toolsets: readonly CommandToolset[]
	agents: readonly AgentToolAssignment[]
}>

export type CommandInventoryItem = Readonly<{
	name: string
	title?: string
	description: string
	behavior: CommandBehavior
}>

export type AgentToolsAdminSnapshot = Readonly<{
	revision: number
	catalogRevision: number
	persistence: 'durable' | 'ephemeral' | 'readonly'
	writable: boolean
	loadError?: string
	commands: readonly CommandInventoryItem[]
	policy: AgentToolsPolicy
}>

export type AgentCommandCatalogSnapshot = Readonly<{
	agentId: string
	policyRevision: number
	catalogRevision: number
	descriptors: readonly CommandDescriptor[]
}>

/** A live command catalog constrained to one persisted Agent assignment. */
export interface AgentCommandCatalog {
	readonly agentId: string
	get(name: string): AnyCommand | undefined
	list(): readonly CommandDescriptor[]
	snapshot(): AgentCommandCatalogSnapshot
	subscribe(listener: (snapshot: AgentCommandCatalogSnapshot) => void): () => void
	execute(
		name: string,
		candidate: unknown,
		context?: CommandContext,
	): Promise<CommandResult<unknown>>
	executeOrThrow(name: string, candidate: unknown, context?: CommandContext): Promise<unknown>
}
