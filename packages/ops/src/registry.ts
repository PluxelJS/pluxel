import { deepFreeze } from './internal/freeze'
import {
	OpError,
	type AnyOperation,
	type OpContext,
	type OpDescriptor,
	type OpResult,
	type Registration,
} from './types'

export class OperationRegistry<Ctx extends OpContext = OpContext> {
	private readonly entries = new Map<string, AnyOperation<Ctx>>()
	private versionValue = 0
	private listCacheVersion = -1
	private listCache: OpDescriptor[] = []

	register(op: AnyOperation<Ctx>): Registration {
		if (this.entries.has(op.id)) {
			throw new OpError('E_OP_CONFIG', 'Invalid operation config', {
				message: `Operation "${op.id}" is already registered`,
				details: { id: op.id },
			})
		}
		this.entries.set(op.id, op)
		this.bumpVersion()
		let active = true
		return {
			id: op.id,
			dispose: () => {
				if (!active) return
				active = false
				this.remove(op.id)
			},
		}
	}

	private remove(id: string): boolean {
		if (!this.entries.delete(id)) return false
		this.bumpVersion()
		return true
	}

	private bumpVersion() {
		this.versionValue += 1
		this.listCacheVersion = -1
	}

	get(id: string) {
		return this.entries.get(id)
	}

	list(): OpDescriptor[] {
		if (this.listCacheVersion === this.versionValue) return [...this.listCache]
		const out = [...this.entries.values()]
			.map((op) => op.descriptor)
			.sort((left, right) => left.id.localeCompare(right.id))
		this.listCache = deepFreeze(out)
		this.listCacheVersion = this.versionValue
		return [...this.listCache]
	}

	async invoke<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<OpResult<O>> {
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
		return (await op.invoke(candidate, ctx)) as OpResult<O>
	}

	async invokeRaw<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<O> {
		const op = this.get(id)
		if (!op) {
			throw new OpError('E_OP_NOT_FOUND', 'Operation not found', {
				details: { id },
				message: `Operation "${id}" is not registered`,
			})
		}
		return (await op.invokeRaw(candidate, ctx)) as O
	}
}

export const createRegistry = <Ctx extends OpContext = OpContext>() => new OperationRegistry<Ctx>()
