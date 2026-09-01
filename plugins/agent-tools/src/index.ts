import { CommandError, type CommandContext, type CommandDescriptor } from '@pluxel/commands'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { AgentToolsConfig } from './config.ts'
import type {
	AgentToolAssignmentSnapshot,
	AgentToolsSnapshot,
	AgentToolsetSnapshot,
} from './contracts.ts'
import { AgentToolsWorkbench } from './workbench.ts'

const machineIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const emptyDescriptors: readonly CommandDescriptor[] = Object.freeze([])
const emptyCommandNames: ReadonlySet<string> = new Set()

export type AgentCommandCatalogSnapshot = Readonly<{
	agentId: string
	available: boolean
	policyRevision: number
	catalogRevision: number
	descriptors: readonly CommandDescriptor[]
}>

/** A live command catalog constrained to one Agent assignment. */
export interface AgentCommandCatalog {
	readonly agentId: string
	list(): readonly CommandDescriptor[]
	snapshot(): AgentCommandCatalogSnapshot
	subscribe(listener: (snapshot: AgentCommandCatalogSnapshot) => void): () => void
	execute(name: string, candidate: unknown, context?: CommandContext): Promise<unknown>
}

type PolicyProjection = Readonly<{
	revision: number
	allowedByAgent: ReadonlyMap<string, ReadonlySet<string>>
	toolsets: readonly AgentToolsetPolicy[]
	assignments: readonly AgentToolAssignmentPolicy[]
}>

type AgentToolsetPolicy = Readonly<{
	id: string
	label: string
	description?: string
	commandNames: readonly string[]
}>

type AgentToolAssignmentPolicy = Readonly<{
	agentId: string
	label: string
	toolsetIds: readonly string[]
}>

type AgentToolsPolicyView = Readonly<{
	toolsets: readonly Readonly<{
		id: string
		label: string
		description?: string
		commandNames: readonly string[]
	}>[]
	agents: readonly Readonly<{
		agentId: string
		label: string
		toolsetIds: readonly string[]
	}>[]
}>

type CommandCatalogSource = Readonly<{
	snapshot(): Readonly<{ revision: number; descriptors: readonly CommandDescriptor[] }>
	subscribe(listener: () => void): () => void
	execute(name: string, candidate: unknown, context?: CommandContext): Promise<unknown>
}>

@Plugin({ displayName: 'Agent tools' })
export class AgentToolsPlugin extends BasePlugin {
	private readonly config = this.configs.use(AgentToolsConfig)
	private controller?: AgentToolsController

	protected override init(): () => void {
		const controller = new AgentToolsController(this.ctx.commands, (error) =>
			this.ctx.logger.error('Agent tools catalog listener failed', { error }),
		)
		controller.start(this.config)
		this.controller = controller
		this.ctx.workbench?.publish(AgentToolsWorkbench, {
			overview: ({ signal, dataChanged }) => {
				const unsubscribePolicy = controller.subscribePolicy(dataChanged)
				const unsubscribeCatalog = controller.commands.subscribe(dataChanged)
				let active = true
				const release = () => {
					if (!active) return
					active = false
					unsubscribePolicy()
					unsubscribeCatalog()
				}
				signal.addEventListener('abort', release, { once: true })
				if (signal.aborted) release()
				return { load: () => ({ status: controller.snapshot() }) }
			},
		})
		this.configs.onUpdate(this.config, ({ desired }) => {
			controller.update(desired)
		})
		return () => {
			controller.stop()
			if (this.controller === controller) this.controller = undefined
		}
	}

	/** Create a live, fail-closed catalog for one stable Agent identity. */
	catalog(agentId: string): AgentCommandCatalog {
		const controller = this.controller
		if (!controller) throw new Error('AgentToolsPlugin is not running')
		const normalizedAgentId = normalizeAgentId(agentId)
		return controller.catalog(normalizedAgentId)
	}

	/** Read a detached projection for setup selection and diagnostics. */
	snapshot(): AgentToolsSnapshot {
		const controller = this.controller
		if (!controller) throw new Error('AgentToolsPlugin is not running')
		return controller.snapshot()
	}
}

class AgentToolsController {
	private active = false
	private projection: PolicyProjection = Object.freeze({
		revision: 0,
		allowedByAgent: new Map(),
		toolsets: Object.freeze([]),
		assignments: Object.freeze([]),
	})
	private readonly listeners = new Set<() => void>()

	constructor(
		readonly commands: CommandCatalogSource,
		private readonly reportListenerError: (error: unknown) => void,
	) {}

	start(config: AgentToolsPolicyView): void {
		this.projection = projectPolicy(config, 1)
		this.active = true
	}

	update(config: AgentToolsPolicyView): void {
		this.projection = projectPolicy(config, this.projection.revision + 1)
		this.notify()
	}

	stop(): void {
		if (!this.active) return
		this.active = false
		this.projection = Object.freeze({
			revision: this.projection.revision + 1,
			allowedByAgent: new Map(),
			toolsets: Object.freeze([]),
			assignments: Object.freeze([]),
		})
		this.notify()
		this.listeners.clear()
	}

	catalog(agentId: string): AgentCommandCatalog {
		return new BoundAgentCommandCatalog(this, agentId)
	}

	snapshot(): AgentToolsSnapshot {
		const catalog = this.commands.snapshot()
		const availableNames = new Set(catalog.descriptors.map(({ name }) => name))
		const assignedNames = new Set(
			this.projection.toolsets.flatMap(({ commandNames }) => commandNames),
		)
		const namesByToolset = new Map(
			this.projection.toolsets.map((toolset) => [toolset.id, toolset.commandNames] as const),
		)
		const toolsets: readonly AgentToolsetSnapshot[] = Object.freeze(
			this.projection.toolsets.map((toolset) =>
				Object.freeze({
					...toolset,
					commandNames: Object.freeze([...toolset.commandNames]),
					availableCommandNames: Object.freeze(
						toolset.commandNames.filter((name) => availableNames.has(name)),
					),
					missingCommandNames: Object.freeze(
						toolset.commandNames.filter((name) => !availableNames.has(name)),
					),
				}),
			),
		)
		const assignments: readonly AgentToolAssignmentSnapshot[] = Object.freeze(
			this.projection.assignments.map((assignment) => {
				const commandNames = new Set<string>()
				for (const toolsetId of assignment.toolsetIds) {
					for (const name of namesByToolset.get(toolsetId) ?? []) commandNames.add(name)
				}
				return Object.freeze({
					...assignment,
					toolsetIds: Object.freeze([...assignment.toolsetIds]),
					commandNames: Object.freeze([...commandNames].toSorted()),
					availableCommandNames: Object.freeze(
						[...commandNames].filter((name) => availableNames.has(name)).toSorted(),
					),
					missingCommandNames: Object.freeze(
						[...commandNames].filter((name) => !availableNames.has(name)).toSorted(),
					),
				})
			}),
		)
		return Object.freeze({
			policyRevision: this.projection.revision,
			catalogRevision: catalog.revision,
			commands: Object.freeze(
				catalog.descriptors.map(({ name, title, description, behavior }) =>
					Object.freeze({ name, ...(title ? { title } : {}), description, behavior }),
				),
			),
			toolsets,
			assignments,
			ungroupedCommandNames: Object.freeze(
				catalog.descriptors.map(({ name }) => name).filter((name) => !assignedNames.has(name)),
			),
		})
	}

	currentProjection(): PolicyProjection {
		return this.projection
	}

	isAvailable(): boolean {
		return this.active
	}

	subscribePolicy(listener: () => void): () => void {
		this.listeners.add(listener)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.listeners.delete(listener)
		}
	}

	private notify(): void {
		for (const listener of new Set(this.listeners)) {
			try {
				listener()
			} catch (error) {
				this.reportListenerError(error)
			}
		}
	}
}

class BoundAgentCommandCatalog implements AgentCommandCatalog {
	private listSource?: readonly CommandDescriptor[]
	private listPolicyRevision = -1
	private listCache = emptyDescriptors

	constructor(
		private readonly owner: AgentToolsController,
		readonly agentId: string,
	) {}

	list(): readonly CommandDescriptor[] {
		return this.snapshot().descriptors
	}

	snapshot(): AgentCommandCatalogSnapshot {
		const catalog = this.owner.commands.snapshot()
		const projection = this.owner.currentProjection()
		const available = this.owner.isAvailable()
		return Object.freeze({
			agentId: this.agentId,
			available,
			policyRevision: projection.revision,
			catalogRevision: catalog.revision,
			descriptors: this.filtered(catalog.descriptors, projection, available),
		})
	}

	subscribe(listener: (snapshot: AgentCommandCatalogSnapshot) => void): () => void {
		if (typeof listener !== 'function')
			throw new TypeError('Agent catalog listener must be a function')
		const notify = () => listener(this.snapshot())
		const disposeCatalog = this.owner.commands.subscribe(notify)
		const disposePolicy = this.owner.subscribePolicy(notify)
		let active = true
		return () => {
			if (!active) return
			active = false
			disposeCatalog()
			disposePolicy()
		}
	}

	async execute(name: string, candidate: unknown, context?: CommandContext): Promise<unknown> {
		if (!this.owner.isAvailable()) {
			throw new CommandError('ABORTED', 'Agent tool catalog is unavailable')
		}
		const allowed = this.owner.currentProjection().allowedByAgent.get(this.agentId)
		if (!allowed?.has(name)) {
			throw new CommandError('FORBIDDEN', 'Command is not assigned to this Agent', {
				message: `Command "${name}" is not assigned to Agent "${this.agentId}"`,
				details: {
					permission: `agent-tools:${this.agentId}`,
					reason: 'command_not_assigned',
				},
			})
		}
		return await this.owner.commands.execute(name, candidate, context)
	}

	private filtered(
		source: readonly CommandDescriptor[],
		projection: PolicyProjection,
		available: boolean,
	): readonly CommandDescriptor[] {
		if (!available) return emptyDescriptors
		if (source === this.listSource && this.listPolicyRevision === projection.revision) {
			return this.listCache
		}
		this.listSource = source
		this.listPolicyRevision = projection.revision
		const allowed = projection.allowedByAgent.get(this.agentId) ?? emptyCommandNames
		this.listCache = Object.freeze(source.filter((descriptor) => allowed.has(descriptor.name)))
		return this.listCache
	}
}

function projectPolicy(config: AgentToolsPolicyView, revision: number): PolicyProjection {
	const toolsetRecords = Object.freeze(
		config.toolsets.map((toolset) =>
			Object.freeze({
				id: toolset.id,
				label: toolset.label,
				...(toolset.description ? { description: toolset.description } : {}),
				commandNames: Object.freeze([...toolset.commandNames]),
			}),
		),
	)
	const assignments = Object.freeze(
		config.agents.map((agent) =>
			Object.freeze({
				agentId: agent.agentId,
				label: agent.label,
				toolsetIds: Object.freeze([...agent.toolsetIds]),
			}),
		),
	)
	const toolsets = new Map(toolsetRecords.map((toolset) => [toolset.id, toolset.commandNames]))
	const allowedByAgent = new Map<string, ReadonlySet<string>>()
	for (const agent of assignments) {
		const names = new Set<string>()
		for (const toolsetId of agent.toolsetIds) {
			for (const name of toolsets.get(toolsetId) ?? []) names.add(name)
		}
		allowedByAgent.set(agent.agentId, names)
	}
	return Object.freeze({ revision, allowedByAgent, toolsets: toolsetRecords, assignments })
}

function normalizeAgentId(value: string): string {
	const normalized = String(value).trim()
	if (!machineIdPattern.test(normalized)) {
		throw new TypeError('agentId must be a stable 1–128 character machine identifier')
	}
	return normalized
}

export { AgentToolsConfig } from './config.ts'
export type {
	AgentToolAssignmentSnapshot,
	AgentToolCommandSummary,
	AgentToolsSnapshot,
	AgentToolsetSnapshot,
} from './contracts.ts'
export type { AgentToolAssignment, AgentToolsPluginConfig, CommandToolset } from './config.ts'
