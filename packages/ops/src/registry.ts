import { deepFreeze } from './internal/freeze'
import {
	OpError,
	type AnyOperation,
	type OpContext,
	type OpDescriptor,
	type OperationListOptions,
	type OperationRegisterOptions,
	type OpResult,
	type OperationEntry,
	type ToolListOptions,
	type ToolDef,
} from './types'

type RegistryEntry<Ctx extends OpContext> = {
	owner?: string
	op: AnyOperation<Ctx>
}

export class OperationRegistry<Ctx extends OpContext = OpContext> {
	private readonly entries = new Map<string, RegistryEntry<Ctx>>()
	private readonly ownerIds = new Map<string, Set<string>>()
	private readonly toolOwnerByName = new Map<string, string>()
	private versionValue = 0
	private toolCacheVersion = -1
	private toolCache: ToolDef[] = []

	get version() {
		return this.versionValue
	}

	register<O>(
		op: AnyOperation<Ctx> & { run(candidate: unknown, ctx?: Ctx): Promise<O> },
		opts?: OperationRegisterOptions,
	) {
		if (this.entries.has(op.id)) {
			throw new OpError('E_OP_CONFIG', 'Invalid operation config', {
				message: `Operation "${op.id}" is already registered`,
				details: { id: op.id },
			})
		}
		const toolName = op.descriptor.transports.tool?.name
		if (toolName) {
			const existingId = this.toolOwnerByName.get(toolName)
			if (existingId) {
				throw new OpError('E_OP_CONFIG', 'Invalid operation config', {
					message: `Tool name "${toolName}" is already registered by "${existingId}"`,
					details: { id: op.id, field: 'tool.name', reason: 'duplicate_tool_name' },
				})
			}
		}
		this.entries.set(op.id, { owner: opts?.owner, op })
		this.addIndexes(op, opts?.owner)
		this.bumpVersion()
		return () => this.unregister(op.id)
	}

	unregister(id: string) {
		const entry = this.entries.get(id)
		if (!entry) return
		this.removeEntry(id, entry)
		this.bumpVersion()
	}

	unregisterOwner(owner: string) {
		const ids = [...(this.ownerIds.get(owner) ?? [])]
		for (const id of ids) {
			const entry = this.entries.get(id)
			if (entry) this.removeEntry(id, entry)
		}
		if (ids.length > 0) this.bumpVersion()
		return ids
	}

	private bumpVersion() {
		this.versionValue += 1
	}

	private addIndexes(op: AnyOperation<Ctx>, owner: string | undefined) {
		if (owner) {
			let ids = this.ownerIds.get(owner)
			if (!ids) {
				ids = new Set()
				this.ownerIds.set(owner, ids)
			}
			ids.add(op.id)
		}
		const toolName = op.descriptor.transports.tool?.name
		if (toolName) this.toolOwnerByName.set(toolName, op.id)
	}

	private removeEntry(id: string, entry: RegistryEntry<Ctx>) {
		this.entries.delete(id)
		if (entry.owner) {
			const ids = this.ownerIds.get(entry.owner)
			ids?.delete(id)
			if (ids?.size === 0) this.ownerIds.delete(entry.owner)
		}
		const toolName = entry.op.descriptor.transports.tool?.name
		if (toolName && this.toolOwnerByName.get(toolName) === id) {
			this.toolOwnerByName.delete(toolName)
		}
	}

	has(id: string) {
		return this.entries.has(id)
	}

	get(id: string) {
		return this.entries.get(id)?.op
	}

	getDescriptor(id: string) {
		return this.entries.get(id)?.op.descriptor
	}

	getEntry(id: string): OperationEntry | undefined {
		const entry = this.entries.get(id)
		if (!entry) return undefined
		return {
			...(entry.owner ? { owner: entry.owner } : {}),
			descriptor: entry.op.descriptor,
		}
	}

	list(opts?: OperationListOptions): OpDescriptor[] {
		const out: OpDescriptor[] = []
		for (const entry of this.entries.values()) {
			if (this.matchesEntry(entry, opts)) out.push(entry.op.descriptor)
		}
		out.sort((left, right) => left.id.localeCompare(right.id))
		return out
	}

	listEntries(opts?: OperationListOptions) {
		const out: OperationEntry[] = []
		for (const entry of this.entries.values()) {
			if (!this.matchesEntry(entry, opts)) continue
			out.push({
				...(entry.owner ? { owner: entry.owner } : {}),
				descriptor: entry.op.descriptor,
			})
		}
		out.sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id))
		return out
	}

	private matchesEntry(entry: RegistryEntry<Ctx>, opts: OperationListOptions | undefined) {
		if (opts?.owner && entry.owner !== opts.owner) return false
		if (!opts?.includeInternal && entry.op.descriptor.exposure.internal) return false
		if (opts?.carrier === 'rpc' && entry.op.descriptor.exposure.rpc !== true) return false
		if (opts?.carrier === 'tool' && !entry.op.descriptor.transports.tool) return false
		if (opts?.carrier === 'cli' && !entry.op.descriptor.transports.cli) return false
		return true
	}

	listTools(opts?: ToolListOptions): ToolDef[] {
		if (opts?.includeInternal === true) {
			return this.buildToolList(true)
		}
		if (this.toolCacheVersion === this.versionValue) return this.toolCache
		this.toolCache = this.buildToolList(false)
		this.toolCacheVersion = this.versionValue
		return this.toolCache
	}

	private buildToolList(includeInternal: boolean): ToolDef[] {
		const out: ToolDef[] = []
		for (const entry of this.entries.values()) {
			if (!includeInternal && entry.op.descriptor.exposure.internal) continue
			const tool = entry.op.descriptor.transports.tool
			if (tool) out.push(tool)
		}
		out.sort((left, right) => left.id.localeCompare(right.id))
		return deepFreeze(out)
	}

	async invoke<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<O> {
		const op = this.get(id)
		if (!op) {
			throw new OpError('E_OP_NOT_FOUND', 'Operation not found', {
				details: { id },
				message: `Operation "${id}" is not registered`,
			})
		}
		return await op.run(candidate, ctx)
	}

	async invokeSafe<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<OpResult<O>> {
		const op = this.get(id)
		if (!op) {
			return {
				ok: false,
				error: new OpError('E_OP_NOT_FOUND', 'Operation not found', {
					details: { id },
					message: `Operation "${id}" is not registered`,
				}),
			}
		}
		return (await op.runSafe(candidate, ctx)) as OpResult<O>
	}
}
