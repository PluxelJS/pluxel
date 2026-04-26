import {
	createSpace,
	type AnyOperation,
	type CliHelpCommandResult,
	type CliHelpIndexResult,
	type OpContext,
	type OpDescriptor,
	type OperationEntry,
	type OperationListOptions,
	type OperationRegisterOptions,
	type OpResult,
	type ToolDef,
	type ToolListOptions,
} from '@pluxel/ops'
import { Injectable, type Context as PluxelContext } from '@pluxel/core'

import type {
	RuntimeOpCatalogEntry,
	RuntimeOpCatalogOwnerKind,
	RuntimeOpToolsetManifest,
} from '../../web/protocol'
import {
	buildOpsToolsetManifest,
	readOpsToolsets,
	type OpsToolsetInput,
	type OpsToolsetOutput,
	writeOpsToolsets,
} from './toolsets'

const serviceName = 'ops' as const
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

export type RuntimeOpsRegisterOptions = OperationRegisterOptions

export type RuntimeOpCatalogOptions = OperationListOptions

export type { RuntimeOpCatalogEntry } from '../../web/protocol'

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[serviceName]: OpsService
		}
	}
}

class OpsToolsetsHandle {
	constructor(private readonly owner: OpsService) {}

	list(): OpsToolsetOutput[] {
		return readOpsToolsets(resolveRootContext(this.owner.ctx))
	}

	write(toolsets: OpsToolsetInput[]): OpsToolsetOutput[] {
		return writeOpsToolsets(resolveRootContext(this.owner.ctx), toolsets)
	}

	resolve(toolsetId: string): RuntimeOpToolsetManifest | null {
		const target = this.list().find((toolset) => toolset.toolsetId === toolsetId)
		if (!target) return null
		return buildOpsToolsetManifest({
			toolset: target,
			entries: resolveRootContext(this.owner.ctx).ops.listCatalog({ carrier: 'rpc' }),
		})
	}
}

const toRuntimeOpCatalogEntry = (item: OperationEntry): RuntimeOpCatalogEntry => {
	const { descriptor } = item
	const owner = item.owner ?? 'context:unknown'
	const parsed = parseRuntimeOpOwner(owner)
	const entry: RuntimeOpCatalogEntry = {
		id: descriptor.id,
		owner,
		ownerKind: parsed.ownerKind,
		descriptor,
	}
	if (parsed.pluginId) entry.pluginId = parsed.pluginId
	return entry
}

@Injectable({ key: serviceName })
export class OpsService {
	private readonly space = createSpace<RuntimeOpContext>()
	private readonly toolsetsHandle = new OpsToolsetsHandle(this)

	constructor(public ctx: PluxelContext) {}

	get version(): number {
		return this.space.version
	}

	get toolsets(): OpsToolsetsHandle {
		return this.toolsetsHandle
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

	getOwner(id: string): string | undefined {
		return this.space.getEntry(id)?.owner
	}

	list(options?: OperationListOptions): OpDescriptor[] {
		return this.space.list(options)
	}

	listTools(options?: ToolListOptions): ToolDef[] {
		return this.space.listTools(options)
	}

	listCatalog(options?: RuntimeOpCatalogOptions): RuntimeOpCatalogEntry[] {
		const entries = this.space.listEntries({
			owner: options?.owner,
			carrier: options?.carrier,
			includeInternal: options?.includeInternal,
		})
		const out: RuntimeOpCatalogEntry[] = []
		for (const entry of entries) out.push(toRuntimeOpCatalogEntry(entry))
		return out
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

	private assertReservedNamespace(op: RuntimeOperation, owner: string): void {
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
			throw new Error(`CLI trigger "${reservedTrigger}" uses a reserved runtime command namespace`)
		}
	}
}

function resolveRootContext(ctx: PluxelContext): PluxelContext {
	return (ctx.root ?? ctx) as PluxelContext
}

function parseRuntimeOpOwner(owner: string): {
	ownerKind: RuntimeOpCatalogOwnerKind
	pluginId?: string
} {
	if (owner.startsWith('plugin:')) {
		const pluginId = owner.slice('plugin:'.length).trim()
		return pluginId ? { ownerKind: 'plugin', pluginId } : { ownerKind: 'plugin' }
	}
	if (owner.startsWith('runtime:')) return { ownerKind: 'runtime' }
	return { ownerKind: 'context' }
}
