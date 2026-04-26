import { CliAdapter } from './adapters/cli/adapter'
import { OperationRegistry } from './registry'
import type {
	AnyOperation,
	CliHelpCommandResult,
	CliHelpIndexResult,
	OpContext,
	OperationListOptions,
	OperationRegisterOptions,
	OpResult,
	OperationSpace,
	OperationSpaceOptions,
	ToolDef,
	ToolListOptions,
} from './types'

class SpaceImpl<Ctx extends OpContext = OpContext> implements OperationSpace<Ctx> {
	private readonly registry = new OperationRegistry<Ctx>()
	private readonly cli: CliAdapter<Ctx>

	constructor(opts?: OperationSpaceOptions) {
		this.cli = new CliAdapter<Ctx>(opts)
	}

	get version() {
		return this.registry.version
	}

	register(op: AnyOperation<Ctx>, opts?: OperationRegisterOptions) {
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
		const ids = this.registry.unregisterOwner(owner)
		this.cli.removeMany(ids)
		return ids.length
	}

	has(id: string) {
		return this.registry.has(id)
	}

	get(id: string) {
		return this.registry.get(id)
	}

	getEntry(id: string) {
		return this.registry.getEntry(id)
	}

	getDescriptor(id: string) {
		return this.registry.getDescriptor(id)
	}

	list(opts?: OperationListOptions) {
		return this.registry.list(opts)
	}

	listEntries(opts?: OperationListOptions) {
		return this.registry.listEntries(opts)
	}

	listTools(opts?: ToolListOptions): ToolDef[] {
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

export const createSpace = <Ctx extends OpContext = OpContext>(
	opts?: OperationSpaceOptions,
): OperationSpace<Ctx> => new SpaceImpl<Ctx>(opts)
