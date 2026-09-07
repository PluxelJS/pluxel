export type AgentToolCommandSummary = Readonly<{
	name: string
	title?: string
	description: string
	behavior:
		| Readonly<{ kind: 'query'; world: 'closed' | 'open' }>
		| Readonly<{
				kind: 'mutation'
				destructive: boolean
				idempotent: boolean
				world: 'closed' | 'open'
		  }>
}>

export type AgentToolsetSnapshot = Readonly<{
	id: string
	label: string
	description?: string
	commandNames: readonly string[]
	availableCommandNames: readonly string[]
	missingCommandNames: readonly string[]
}>

export type AgentToolAssignmentSnapshot = Readonly<{
	agentId: string
	label: string
	toolsetIds: readonly string[]
	commandNames: readonly string[]
	availableCommandNames: readonly string[]
	missingCommandNames: readonly string[]
}>

/** Detached projection of the current command catalog and AgentTools policy. */
export type AgentToolsSnapshot = Readonly<{
	policyRevision: number
	catalogRevision: number
	commands: readonly AgentToolCommandSummary[]
	toolsets: readonly AgentToolsetSnapshot[]
	assignments: readonly AgentToolAssignmentSnapshot[]
	ungroupedCommandNames: readonly string[]
}>
