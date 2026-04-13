import { CliAdapter } from './adapters/cli/adapter'
import { OperationRegistry, type RegisterOptions } from './registry'
import type { AnyOperation, CliHelpCommandResult, CliHelpIndexResult, OpContext, OpResult, OperationSpace, ToolDef } from './types'

export class OpsSpace<Ctx extends OpContext = OpContext> implements OperationSpace<Ctx> {
	private readonly registry = new OperationRegistry<Ctx>()
	private readonly cli: CliAdapter<Ctx>

	constructor(opts?: { caseInsensitive?: boolean; maxTextLength?: number }) {
		this.cli = new CliAdapter<Ctx>(opts)
	}

	get version() {
		return this.registry.version
	}

	register(op: AnyOperation<Ctx>, opts?: RegisterOptions) {
		const unregister = this.registry.register(op, opts)
		try {
			this.cli.add(op)
		} catch (error) {
			unregister()
			throw error
		}
		return () => {
			this.cli.remove(op.id)
			unregister()
		}
	}

	unregister(id: string) {
		this.cli.remove(id)
		this.registry.unregister(id)
	}

	unregisterOwner(owner: string) {
		const ids = this.registry.listIdsByOwner(owner)
		for (const id of ids) this.cli.remove(id)
		return this.registry.unregisterOwner(owner)
	}

	has(id: string) {
		return this.registry.has(id)
	}

	get(id: string) {
		return this.registry.get(id)
	}

	getDescriptor(id: string) {
		return this.registry.getDescriptor(id)
	}

	list(opts?: {
		owner?: string
		carrier?: 'rpc' | 'tool' | 'cli'
		includeInternal?: boolean
	}) {
		return this.registry.list(opts)
	}

	listTools(opts?: { includeInternal?: boolean }): ToolDef[] {
		return this.registry.listTools(opts)
	}

	invoke<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<O> {
		return this.registry.invoke(id, candidate, ctx)
	}

	invokeSafe<O = unknown>(id: string, candidate: unknown, ctx?: Ctx): Promise<OpResult<O>> {
		return this.registry.invokeSafe(id, candidate, ctx)
	}

	dispatch<O = unknown>(text: string, ctx?: Ctx): Promise<O> {
		return this.cli.dispatch(text, ctx)
	}

	helpIndex(): CliHelpIndexResult {
		return this.cli.helpIndex()
	}

	helpCommand(name: string): CliHelpCommandResult | undefined {
		return this.cli.helpCommand(name)
	}
}

export const createSpace = <Ctx extends OpContext = OpContext>(opts?: {
	caseInsensitive?: boolean
	maxTextLength?: number
}): OperationSpace<Ctx> => new OpsSpace<Ctx>(opts)
