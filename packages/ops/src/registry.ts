import { deepFreeze } from './internal/freeze'
import { OpError, type AnyOperation, type OpContext, type OpDescriptor, type OpResult, type ToolDef } from './types'

export type RegisterOptions = {
	owner?: string
}

export class OperationRegistry<Ctx extends OpContext = OpContext> {
	private readonly entries = new Map<string, { owner?: string; op: AnyOperation<Ctx> }>()
	private versionValue = 0
	private toolCacheVersion = -1
	private toolCache: ToolDef[] = []

	get version() {
		return this.versionValue
	}

	register<O>(op: AnyOperation<Ctx> & { run(candidate: unknown, ctx?: Ctx): Promise<O> }, opts?: RegisterOptions) {
		if (this.entries.has(op.id)) {
			throw new OpError('E_INTERNAL', 'Internal error', {
				message: `Operation "${op.id}" is already registered`,
				details: { id: op.id },
			})
		}
		this.entries.set(op.id, { owner: opts?.owner, op })
		this.bumpVersion()
		return () => this.unregister(op.id)
	}

	unregister(id: string) {
		const removed = this.entries.delete(id)
		if (removed) this.bumpVersion()
	}

	listIdsByOwner(owner: string) {
		const out: string[] = []
		for (const [id, entry] of this.entries.entries()) {
			if (entry.owner === owner) out.push(id)
		}
		return out
	}

	unregisterOwner(owner: string) {
		const ids = this.listIdsByOwner(owner)
		let removed = 0
		for (const id of ids) {
			this.entries.delete(id)
			removed += 1
		}
		if (removed > 0) this.bumpVersion()
		return removed
	}

	private bumpVersion() {
		this.versionValue += 1
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

	list(opts?: {
		owner?: string
		carrier?: 'rpc' | 'tool' | 'cli'
		includeInternal?: boolean
	}) {
		const out: OpDescriptor[] = []
		for (const entry of this.entries.values()) {
			if (opts?.owner && entry.owner !== opts.owner) continue
			if (!opts?.includeInternal && entry.op.descriptor.exposure.internal) continue
			if (opts?.carrier === 'rpc' && entry.op.descriptor.exposure.rpc !== true) continue
			if (opts?.carrier === 'tool' && !entry.op.descriptor.transports.tool) continue
			if (opts?.carrier === 'cli' && !entry.op.descriptor.transports.cli) continue
			out.push(entry.op.descriptor)
		}
		out.sort((left, right) => left.id.localeCompare(right.id))
		return out
	}

	listTools(opts?: { includeInternal?: boolean }): ToolDef[] {
		if (opts?.includeInternal === true) {
			return deepFreeze(
				this.list({ carrier: 'tool', includeInternal: true })
					.map((descriptor) => descriptor.transports.tool)
					.filter((entry): entry is ToolDef => !!entry),
			)
		}
		if (this.toolCacheVersion === this.versionValue) return this.toolCache
		this.toolCache = deepFreeze(
			this.list({ carrier: 'tool', includeInternal: false })
				.map((descriptor) => descriptor.transports.tool)
				.filter((entry): entry is ToolDef => !!entry),
		)
		this.toolCacheVersion = this.versionValue
		return this.toolCache
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

export const createOperationRegistry = <Ctx extends OpContext = OpContext>() =>
	new OperationRegistry<Ctx>()
