import {
	createSpace,
	type AnyOperation,
	type CliHelpCommandResult,
	type CliHelpIndexResult,
	type OpContext,
	type OpDescriptor,
	type OpResult,
	type ToolDef,
} from '@pluxel/ops'
import type { Context as PluxelContext } from '@pluxel/core'

const RESERVED_RUNTIME_OP_PREFIXES = ['plugin.', 'plugins.', 'runtime.'] as const
const RESERVED_TOOL_NAME_PREFIXES = [
	'plugin.',
	'plugins.',
	'runtime.',
	'logs.',
	'workspace.',
	'hmr.',
] as const
const RESERVED_CLI_TRIGGER_PREFIXES = ['plugin ', 'plugins ', 'runtime '] as const

export interface RuntimeOpSource {
	kind: 'runtime' | 'plugin' | 'rpc' | 'cli' | 'mcp' | 'http'
	pluginId?: string
}

export interface RuntimeOpContext extends OpContext {
	runtime: PluxelContext
	source?: RuntimeOpSource
}

export type RuntimeOperation = AnyOperation<RuntimeOpContext>

export type RuntimeOpContextInput = Omit<RuntimeOpContext, 'runtime'>

export interface RuntimeOpsRegisterOptions {
	owner?: string
}

export class OpsService {
	private readonly space = createSpace<RuntimeOpContext>()

	constructor(public ctx: PluxelContext) {}

	get version(): number {
		return this.space.version
	}

	register(op: RuntimeOperation, options: RuntimeOpsRegisterOptions = {}): () => void {
		const owner = options.owner ?? this.resolveOwner()
		this.assertReservedNamespace(op, owner)
		const unregister = this.space.register(op, {
			owner,
		})

		let active = true
		const remove = () => {
			if (!active) return
			active = false
			guard.cancel()
			unregister()
		}
		const guard = this.ctx.effects.defer(() => {
			if (!active) return
			active = false
			unregister()
		})

		return remove
	}

	unregister(id: string): void {
		this.space.unregister(id)
	}

	has(id: string): boolean {
		return this.space.has(id)
	}

	get(id: string): RuntimeOperation | undefined {
		return this.space.get(id)
	}

	getDescriptor(id: string): OpDescriptor | undefined {
		return this.space.getDescriptor(id)
	}

	list(options?: {
		owner?: string
		carrier?: 'rpc' | 'tool' | 'cli'
		includeInternal?: boolean
	}): OpDescriptor[] {
		return this.space.list(options)
	}

	listTools(options?: { includeInternal?: boolean }): ToolDef[] {
		return this.space.listTools(options)
	}

	async invoke<O = unknown>(
		id: string,
		candidate: unknown,
		ctx?: RuntimeOpContextInput,
	): Promise<O> {
		return await this.space.invoke<O>(id, candidate, this.createExecContext(ctx))
	}

	async invokeSafe<O = unknown>(
		id: string,
		candidate: unknown,
		ctx?: RuntimeOpContextInput,
	): Promise<OpResult<O>> {
		return await this.space.invokeSafe<O>(id, candidate, this.createExecContext(ctx))
	}

	async dispatch<O = unknown>(text: string, ctx?: RuntimeOpContextInput): Promise<O> {
		return await this.space.dispatch<O>(text, this.createExecContext(ctx, 'cli'))
	}

	helpIndex(): CliHelpIndexResult {
		return this.space.helpIndex()
	}

	helpCommand(name: string): CliHelpCommandResult | undefined {
		return this.space.helpCommand(name)
	}

	private createExecContext(
		input?: RuntimeOpContextInput,
		kind?: RuntimeOpSource['kind'],
	): RuntimeOpContext {
		const runtime = this.ctx
		return {
			...input,
			runtime,
			source: input?.source ?? this.resolveSource(kind),
		}
	}

	private resolveOwner(): string {
		const pluginId = String(this.ctx.pluginInfo?.id ?? '').trim()
		if (pluginId) return `plugin:${pluginId}`
		return `context:${this.ctx.name}`
	}

	private resolveSource(kind?: RuntimeOpSource['kind']): RuntimeOpSource {
		const pluginId = String(this.ctx.pluginInfo?.id ?? '').trim()
		if (kind) return pluginId ? { kind, pluginId } : { kind }
		if (pluginId) return { kind: 'plugin', pluginId }
		return { kind: 'runtime' }
	}

	private assertReservedNamespace(
		op: RuntimeOperation,
		owner: string,
	): void {
		if (owner.startsWith('runtime:')) return

		const reservedIdPrefix = RESERVED_RUNTIME_OP_PREFIXES.find((prefix) => op.id.startsWith(prefix))
		if (reservedIdPrefix) {
			throw new Error(
				`Operation id "${op.id}" uses reserved runtime namespace "${reservedIdPrefix}"`,
			)
		}

		const toolName = op.descriptor.transports.tool?.name
		if (toolName) {
			const reservedToolPrefix = RESERVED_TOOL_NAME_PREFIXES.find((prefix) =>
				toolName.startsWith(prefix),
			)
			if (reservedToolPrefix) {
				throw new Error(
					`Tool name "${toolName}" uses reserved runtime namespace "${reservedToolPrefix}"`,
				)
			}
		}

		const triggers = op.descriptor.transports.cli?.triggers ?? []
		const reservedTrigger = triggers.find((trigger) => {
			const normalized = trigger.trim().toLowerCase()
			return RESERVED_CLI_TRIGGER_PREFIXES.some(
				(prefix) => normalized === prefix.trim() || normalized.startsWith(prefix),
			)
		})
		if (reservedTrigger) {
			throw new Error(
				`CLI trigger "${reservedTrigger}" uses a reserved runtime command namespace`,
			)
		}
	}
}
