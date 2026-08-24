import {
	CommandError,
	type AnyCommand,
	type CommandContext,
	type CommandDescriptor,
	type CommandResult,
} from '@pluxel/commands'
import type { Context as CoreContext } from '@pluxel/core'
import type {
	AgentCommandCatalog,
	AgentCommandCatalogSnapshot,
	AgentToolsAdminSnapshot,
	AgentToolsPolicy,
	AgentToolsPolicyInput,
	CommandInventoryItem,
	CommandToolset,
	AgentToolAssignment,
} from '../../agent-tools'
import type { CommandsService } from '../CommandsService'
import type { PersistenceNamespace } from '../persistence/PersistenceService'
import { pinOwnerContext } from '../../context/owner-view'

const storageKey = 'policy.json'
const machineIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/
const commandNamePattern = /^[A-Za-z0-9_.-]{1,128}$/
const maxToolsets = 1_000
const maxAgents = 10_000
const maxCommandsPerToolset = 10_000
const maxToolsetsPerAgent = 1_000
const maxCommandMemberships = 100_000
const maxAgentToolsetMemberships = 100_000
const emptyCommandNames: ReadonlySet<string> = new Set()

export class AgentToolsService {
	readonly ready: Promise<void>

	private policyValue: AgentToolsPolicy = emptyPolicy()
	private revisionValue = 0
	private loadErrorValue: string | undefined
	private readonly storage: PersistenceNamespace
	private readonly listeners = new Set<() => void>()
	private readonly resolvedNamesCache = new Map<
		string,
		{ revision: number; names: ReadonlySet<string> }
	>()
	private mutationTail: Promise<void> = Promise.resolve()

	constructor(public readonly ctx: CoreContext) {
		pinOwnerContext(this, ctx)
		this.storage = ctx.root.persistence.namespace('agent-tools')
		this.ready = this.load()
	}

	async snapshot(): Promise<AgentToolsAdminSnapshot> {
		await this.ready
		const catalog = this.commands.catalogSnapshot()
		return Object.freeze({
			revision: this.revisionValue,
			catalogRevision: catalog.revision,
			persistence: this.ctx.root.persistence.capability,
			writable: this.ctx.root.persistence.capability !== 'readonly',
			...(this.loadErrorValue ? { loadError: this.loadErrorValue } : {}),
			commands: Object.freeze(catalog.descriptors.map(toInventoryItem)),
			policy: this.policyValue,
		})
	}

	async replacePolicy(
		expectedRevision: number,
		input: AgentToolsPolicyInput,
	): Promise<AgentToolsAdminSnapshot> {
		await this.ready
		const task = this.commitAfter(this.mutationTail, expectedRevision, input)
		this.mutationTail = task
		await task
		return await this.snapshot()
	}

	/** Create a live allowlisted catalog for one stable Agent identity. */
	async catalog(agentId: string): Promise<AgentCommandCatalog> {
		await this.ready
		return new BoundAgentCommandCatalog(this, normalizeMachineId(agentId, 'agentId'))
	}

	/** Resolve the currently assigned command names, including commands that are temporarily absent. */
	resolveCommandNames(agentId: string): ReadonlySet<string> {
		const cached = this.resolvedNamesCache.get(agentId)
		if (cached?.revision === this.revisionValue) return cached.names
		const assignment = this.policyValue.agents.find((item) => item.agentId === agentId)
		if (!assignment) return emptyCommandNames
		const wanted = new Set(assignment.toolsetIds)
		const names = new Set<string>()
		for (const toolset of this.policyValue.toolsets) {
			if (!wanted.has(toolset.id)) continue
			for (const name of toolset.commandNames) names.add(name)
		}
		this.resolvedNamesCache.set(agentId, { revision: this.revisionValue, names })
		return names
	}

	get revision(): number {
		return this.revisionValue
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		let active = true
		return () => {
			if (!active) return
			active = false
			this.listeners.delete(listener)
		}
	}

	private get commands(): CommandsService {
		return this.ctx.commands as CommandsService
	}

	private async load(): Promise<void> {
		try {
			const raw = await this.storage.getText(storageKey)
			if (!raw) return
			this.policyValue = normalizePolicy(JSON.parse(raw) as unknown)
			this.revisionValue += 1
			this.resolvedNamesCache.clear()
		} catch (error) {
			this.policyValue = emptyPolicy()
			this.loadErrorValue = errorMessage(error)
			this.ctx.logger.error('Agent tools policy could not be loaded; denying all Agent tools', {
				error,
			})
		}
	}

	private async commitAfter(
		previous: Promise<void>,
		expectedRevision: number,
		input: AgentToolsPolicyInput,
	): Promise<void> {
		try {
			await previous
		} catch {
			// A failed write does not poison later independent mutations.
		}
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== this.revisionValue) {
			throw new Error(
				`Agent tools policy revision conflict: expected ${expectedRevision}, current ${this.revisionValue}`,
			)
		}
		if (this.ctx.root.persistence.capability === 'readonly') {
			throw new Error('Agent tools policy is readonly in this host.')
		}
		const next = normalizePolicy(input)
		await this.storage.put(storageKey, JSON.stringify(next), { atomic: true })
		this.policyValue = next
		this.revisionValue += 1
		this.resolvedNamesCache.clear()
		this.loadErrorValue = undefined
		this.notify()
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch (error) {
				this.ctx.logger.error('Agent tools policy listener failed', { error })
			}
		}
	}
}

class BoundAgentCommandCatalog implements AgentCommandCatalog {
	private listSource?: readonly CommandDescriptor[]
	private listPolicyRevision = -1
	private listCache: readonly CommandDescriptor[] = Object.freeze([])
	private readonly handles = new Map<string, { source: AnyCommand; bound: AnyCommand }>()

	constructor(
		private readonly service: AgentToolsService,
		readonly agentId: string,
	) {}

	get(name: string): AnyCommand | undefined {
		if (!this.isAllowed(name)) return undefined
		const source = this.commands.get(name)
		if (!source) return undefined
		const cached = this.handles.get(name)
		if (cached?.source === source) return cached.bound
		const bound = Object.freeze({
			name: source.name,
			descriptor: source.descriptor,
			execute: (candidate: unknown, context?: CommandContext) =>
				this.execute(name, candidate, context),
			executeOrThrow: (candidate: unknown, context?: CommandContext) =>
				this.executeOrThrow(name, candidate, context),
		})
		this.handles.set(name, { source, bound })
		return bound
	}

	list(): readonly CommandDescriptor[] {
		const source = this.commands.list()
		if (source === this.listSource && this.listPolicyRevision === this.service.revision) {
			return this.listCache
		}
		const allowed = this.service.resolveCommandNames(this.agentId)
		this.listSource = source
		this.listPolicyRevision = this.service.revision
		this.listCache = Object.freeze(source.filter((descriptor) => allowed.has(descriptor.name)))
		return this.listCache
	}

	snapshot(): AgentCommandCatalogSnapshot {
		const catalog = this.commands.catalogSnapshot()
		return Object.freeze({
			agentId: this.agentId,
			policyRevision: this.service.revision,
			catalogRevision: catalog.revision,
			descriptors: this.list(),
		})
	}

	subscribe(listener: (snapshot: AgentCommandCatalogSnapshot) => void): () => void {
		const notify = () => listener(this.snapshot())
		const disposeCatalog = this.commands.subscribe(notify)
		const disposePolicy = this.service.subscribe(notify)
		let active = true
		return () => {
			if (!active) return
			active = false
			disposeCatalog()
			disposePolicy()
		}
	}

	async execute(
		name: string,
		candidate: unknown,
		context?: CommandContext,
	): Promise<CommandResult<unknown>> {
		try {
			return { ok: true, value: await this.executeOrThrow(name, candidate, context) }
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof CommandError
						? error
						: new CommandError('INTERNAL', 'Command failed', { cause: error }),
			}
		}
	}

	async executeOrThrow(
		name: string,
		candidate: unknown,
		context?: CommandContext,
	): Promise<unknown> {
		if (!this.isAllowed(name)) {
			throw new CommandError('FORBIDDEN', 'Command is not assigned to this Agent', {
				message: `Command "${name}" is not assigned to Agent "${this.agentId}"`,
				details: {
					permission: `agent-tools:${this.agentId}`,
					reason: 'command_not_assigned',
				},
			})
		}
		return await this.commands.executeOrThrow(name, candidate, context)
	}

	private isAllowed(name: string): boolean {
		return this.service.resolveCommandNames(this.agentId).has(name)
	}

	private get commands(): CommandsService {
		return this.service.ctx.commands as CommandsService
	}
}

function normalizePolicy(input: unknown): AgentToolsPolicy {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('Agent tools policy must be an object.')
	}
	const raw = input as Partial<AgentToolsPolicyInput>
	if (!Array.isArray(raw.toolsets) || !Array.isArray(raw.agents)) {
		throw new TypeError('Agent tools policy must define toolsets and agents arrays.')
	}
	if (raw.toolsets.length > maxToolsets)
		throw new Error(`Too many toolsets: ${raw.toolsets.length}`)
	if (raw.agents.length > maxAgents) throw new Error(`Too many Agents: ${raw.agents.length}`)

	const toolsetIds = new Set<string>()
	let commandMemberships = 0
	const toolsets = raw.toolsets.map((value, index) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError(`Toolset ${index + 1} must be an object.`)
		}
		const item = value as Partial<CommandToolset>
		const id = normalizeMachineId(item.id, `toolsets[${index}].id`)
		if (toolsetIds.has(id)) throw new Error(`Duplicate toolset id: ${id}`)
		toolsetIds.add(id)
		if (!Array.isArray(item.commandNames)) {
			throw new TypeError(`Toolset "${id}" must define commandNames.`)
		}
		if (item.commandNames.length > maxCommandsPerToolset) {
			throw new Error(`Toolset "${id}" has too many commands: ${item.commandNames.length}`)
		}
		const commandNames = uniqueStrings(item.commandNames, (name) => {
			const normalized = String(name).trim()
			if (!commandNamePattern.test(normalized)) {
				throw new Error(`Invalid command name in toolset "${id}": ${normalized}`)
			}
			return normalized
		}).sort()
		commandMemberships += commandNames.length
		if (commandMemberships > maxCommandMemberships) {
			throw new Error(`Agent tools policy has too many command memberships: ${commandMemberships}`)
		}
		const description = optionalText(item.description, `toolsets[${index}].description`, 1_000)
		return Object.freeze({
			id,
			label: requiredText(item.label, `toolsets[${index}].label`, 120),
			...(description ? { description } : {}),
			commandNames: Object.freeze(commandNames),
		})
	})

	const agentIds = new Set<string>()
	let agentToolsetMemberships = 0
	const agents = raw.agents.map((value, index) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new TypeError(`Agent ${index + 1} must be an object.`)
		}
		const item = value as Partial<AgentToolAssignment>
		const agentId = normalizeMachineId(item.agentId, `agents[${index}].agentId`)
		if (agentIds.has(agentId)) throw new Error(`Duplicate Agent id: ${agentId}`)
		agentIds.add(agentId)
		if (!Array.isArray(item.toolsetIds)) {
			throw new TypeError(`Agent "${agentId}" must define toolsetIds.`)
		}
		if (item.toolsetIds.length > maxToolsetsPerAgent) {
			throw new Error(`Agent "${agentId}" has too many toolsets: ${item.toolsetIds.length}`)
		}
		const assigned = uniqueStrings(item.toolsetIds, (id) =>
			normalizeMachineId(id, `agents[${index}].toolsetIds`),
		)
		agentToolsetMemberships += assigned.length
		if (agentToolsetMemberships > maxAgentToolsetMemberships) {
			throw new Error(
				`Agent tools policy has too many Agent-to-Toolset memberships: ${agentToolsetMemberships}`,
			)
		}
		for (const id of assigned) {
			if (!toolsetIds.has(id)) {
				throw new Error(`Agent "${agentId}" references unknown toolset "${id}".`)
			}
		}
		return Object.freeze({
			agentId,
			label: requiredText(item.label, `agents[${index}].label`, 120),
			toolsetIds: Object.freeze(assigned),
		})
	})

	return Object.freeze({ toolsets: Object.freeze(toolsets), agents: Object.freeze(agents) })
}

function emptyPolicy(): AgentToolsPolicy {
	return Object.freeze({ toolsets: Object.freeze([]), agents: Object.freeze([]) })
}

function toInventoryItem(descriptor: CommandDescriptor): CommandInventoryItem {
	return Object.freeze({
		name: descriptor.name,
		...(descriptor.title ? { title: descriptor.title } : {}),
		description: descriptor.description,
		behavior: descriptor.behavior,
	})
}

function normalizeMachineId(value: unknown, field: string): string {
	const output = typeof value === 'string' ? value.trim() : ''
	if (!machineIdPattern.test(output)) {
		throw new Error(
			`${field} must contain 1-128 letters, digits, dots, underscores, colons, or hyphens.`,
		)
	}
	return output
}

function requiredText(value: unknown, field: string, maxLength: number): string {
	const output = typeof value === 'string' ? value.trim() : ''
	if (!output) throw new Error(`${field} must not be empty.`)
	if (output.length > maxLength)
		throw new Error(`${field} must be at most ${maxLength} characters.`)
	return output
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
	if (value === undefined || value === null || value === '') return undefined
	return requiredText(value, field, maxLength)
}

function uniqueStrings<T>(values: readonly T[], normalize: (value: T) => string): string[] {
	const seen = new Set<string>()
	const output: string[] = []
	for (const value of values) {
		const item = normalize(value)
		if (seen.has(item)) continue
		seen.add(item)
		output.push(item)
	}
	return output
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
