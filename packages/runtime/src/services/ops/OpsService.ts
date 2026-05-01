import {
	createCliAdapter,
	createRegistry,
	type AnyOperation,
	type CliBinding,
	type CliHelpCommandResult,
	type CliHelpIndexResult,
	type OpContext,
	type OpDescriptor,
	type OpResult,
	type Registration,
} from '@pluxel/ops'
import { Injectable, type Context as PluxelContext } from '@pluxel/core'

import { getRuntimeOpMetadata, type RuntimeOpMetadata } from '../../api/ops/helpers'
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
const RESERVED_MCP_TOOL_NAME_PREFIXES = [
	'plugin.',
	'plugins.',
	'runtime.',
	'logs.',
	'workspace.',
	'hmr.',
] as const
const RESERVED_CLI_TRIGGER_PREFIXES = ['plugin ', 'plugins ', 'runtime '] as const

const catalogCacheKey = (options: RuntimeOpCatalogOptions | undefined): string =>
	`${options?.owner ?? ''}\u0000${options?.carrier ?? ''}`

const cloneCatalogEntries = (entries: RuntimeOpCatalogEntry[]): RuntimeOpCatalogEntry[] =>
	entries.map((entry) => ({
		id: entry.id,
		owner: entry.owner,
		ownerKind: entry.ownerKind,
		...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
		descriptor: entry.descriptor,
		bindings: { ...entry.bindings },
		workbench: { ...entry.workbench },
	}))

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

export type RuntimeOpOwner = {
	kind: RuntimeOpCatalogOwnerKind
	id: string
}

export type RuntimeOpsRegisterOptions = {
	owner?: string | RuntimeOpOwner
	lifetime?: { defer?: (fn: () => void) => { cancel?: () => void } }
	metadata?: RuntimeOpMetadata
}

export type RuntimeOpCatalogOptions = {
	owner?: string
	carrier?: 'rpc' | 'mcp' | 'cli' | 'workbench'
}

export type RuntimeMcpToolDef = {
	id: string
	name: string
	title: string
	description: string
	guidance: string
	inputSchema: Record<string, unknown>
	outputSchema: Record<string, unknown>
}

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

const summarizeCliBinding = (binding: CliBinding<any>) => ({
	triggers: [...binding.triggers],
	...(binding.tail
		? {
				tail:
					binding.tail.mode === 'parsebox'
						? {
								mode: 'parsebox' as const,
								entry: String(binding.tail.entry),
								...(binding.tail.placeholder ? { placeholder: binding.tail.placeholder } : {}),
								...(binding.tail.keys ? { keys: [...binding.tail.keys] } : {}),
							}
						: binding.tail,
			}
		: {}),
})

const toRuntimeOpCatalogEntry = (item: {
	owner?: string
	descriptor: OpDescriptor
	metadata: RuntimeOpMetadata
}): RuntimeOpCatalogEntry => {
	const { descriptor, metadata } = item
	const owner = item.owner ?? 'context:unknown'
	const parsed = parseRuntimeOpOwner(owner)
	const entry: RuntimeOpCatalogEntry = {
		id: descriptor.id,
		owner,
		ownerKind: parsed.ownerKind,
		descriptor,
		bindings: {
			...(metadata.cli ? { cli: summarizeCliBinding(metadata.cli) } : {}),
			...(metadata.rpc === true ? { rpc: { exposed: true } } : {}),
			...(metadata.mcp ? { mcp: { name: metadata.mcp.name ?? descriptor.id } } : {}),
		},
		workbench: {
			mutating: metadata.workbench?.mutating === true,
			confirm: metadata.workbench?.confirm === true,
		},
	}
	if (parsed.pluginId) entry.pluginId = parsed.pluginId
	return entry
}

@Injectable({ key: serviceName })
export class OpsService {
	private readonly registry = createRegistry<RuntimeOpContext>()
	private readonly cli = createCliAdapter<RuntimeOpContext>()
	private readonly owners = new Map<string, string>()
	private readonly metadataById = new Map<string, RuntimeOpMetadata>()
	private readonly registrations = new Map<string, { core: Registration; cli?: Registration }>()
	private readonly toolsetsHandle = new OpsToolsetsHandle(this)
	private versionValue = 0
	private catalogCacheVersion = -1
	private readonly catalogCache = new Map<string, RuntimeOpCatalogEntry[]>()

	constructor(public ctx: PluxelContext) {}

	get version(): number {
		return this.versionValue
	}

	get toolsets(): OpsToolsetsHandle {
		return this.toolsetsHandle
	}

	register(op: RuntimeOperation, options: RuntimeOpsRegisterOptions = {}): () => void {
		const owner = this.normalizeOwner(options.owner ?? this.resolveOwner())
		const metadata = { ...getRuntimeOpMetadata(op), ...options.metadata }
		this.assertReservedNamespace(op, owner, metadata)
		const registration = this.registry.register(op)
		let cliRegistration: Registration | undefined
		try {
			cliRegistration = metadata.cli ? this.cli.bind(op, metadata.cli) : undefined
		} catch (error) {
			registration.dispose()
			throw error
		}
		this.owners.set(op.id, owner)
		this.metadataById.set(op.id, metadata)
		this.registrations.set(op.id, {
			core: registration,
			...(cliRegistration ? { cli: cliRegistration } : {}),
		})

		let active = true
		const remove = () => {
			if (!active) return
			active = false
			guard.cancel()
			this.removeRegistration(op.id)
		}
		const lifetime = options.lifetime ?? this.ctx.effects
		const guard = lifetime.defer?.(() => {
			if (!active) return
			active = false
			this.removeRegistration(op.id)
		}) ?? { cancel() {} }
		this.clearCatalogCache()

		return remove
	}

	get(id: string): RuntimeOperation | undefined {
		return this.registry.get(id)
	}

	getOwner(id: string): string | undefined {
		return this.owners.get(id)
	}

	list(options?: RuntimeOpCatalogOptions): OpDescriptor[] {
		return this.listCatalog(options).map((entry) => entry.descriptor)
	}

	listMcpTools(): RuntimeMcpToolDef[] {
		const out: RuntimeMcpToolDef[] = []
		for (const op of this.listRegisteredOperations()) {
			const metadata = this.metadataById.get(op.id) ?? getRuntimeOpMetadata(op)
			if (!metadata.mcp) continue
			const name = metadata.mcp.name ?? op.id
			out.push({
				id: op.id,
				name,
				title: op.descriptor.doc.title,
				description: op.descriptor.doc.description,
				guidance: op.descriptor.doc.description,
				inputSchema: op.descriptor.schemas.input,
				outputSchema: op.descriptor.schemas.output,
			})
		}
		out.sort((left, right) => left.id.localeCompare(right.id))
		return Object.freeze(out) as RuntimeMcpToolDef[]
	}

	listCatalog(options?: RuntimeOpCatalogOptions): RuntimeOpCatalogEntry[] {
		const version = this.version
		if (this.catalogCacheVersion !== version) {
			this.catalogCacheVersion = version
			this.catalogCache.clear()
		}
		const key = catalogCacheKey(options)
		const cached = this.catalogCache.get(key)
		if (cached) return cloneCatalogEntries(cached)

		const out: RuntimeOpCatalogEntry[] = []
		for (const op of this.listRegisteredOperations()) {
			const owner = this.owners.get(op.id)
			const metadata = this.metadataById.get(op.id) ?? getRuntimeOpMetadata(op)
			const entry = toRuntimeOpCatalogEntry({
				owner,
				descriptor: op.descriptor,
				metadata,
			})
			if (options?.owner && entry.owner !== options.owner) continue
			if (options?.carrier === 'workbench' && !metadata.workbench) continue
			if (options?.carrier && options.carrier !== 'workbench' && !entry.bindings[options.carrier]) {
				continue
			}
			out.push(entry)
		}
		out.sort((left, right) => left.id.localeCompare(right.id))
		const frozen = Object.freeze(out.map((entry) => Object.freeze(entry)))
		this.catalogCache.set(key, frozen as RuntimeOpCatalogEntry[])
		return cloneCatalogEntries(frozen as RuntimeOpCatalogEntry[])
	}

	async invoke<O = unknown>(
		id: string,
		candidate: unknown,
		ctx?: RuntimeOpContextInput,
	): Promise<OpResult<O>> {
		return await this.registry.invoke<O>(id, candidate, this.createExecContext(ctx))
	}

	async invokeRaw<O = unknown>(
		id: string,
		candidate: unknown,
		ctx?: RuntimeOpContextInput,
	): Promise<O> {
		return await this.registry.invokeRaw<O>(id, candidate, this.createExecContext(ctx))
	}

	async dispatch<O = unknown>(text: string, ctx?: RuntimeOpContextInput): Promise<OpResult<O>> {
		return await this.cli.dispatch<O>(text, this.createExecContext(ctx, 'cli'))
	}

	async dispatchRaw<O = unknown>(text: string, ctx?: RuntimeOpContextInput): Promise<O> {
		return await this.cli.dispatchRaw<O>(text, this.createExecContext(ctx, 'cli'))
	}

	helpIndex(): CliHelpIndexResult {
		return this.cli.helpIndex()
	}

	helpCommand(name: string): CliHelpCommandResult | undefined {
		return this.cli.helpCommand(name)
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

	private normalizeOwner(owner: string | RuntimeOpOwner): string {
		if (typeof owner === 'string') return owner
		return `${owner.kind}:${owner.id}`
	}

	private resolveSource(kind?: RuntimeOpSource['kind']): RuntimeOpSource {
		const pluginId = String(this.ctx.pluginInfo?.id ?? '').trim()
		if (kind) return pluginId ? { kind, pluginId } : { kind }
		if (pluginId) return { kind: 'plugin', pluginId }
		return { kind: 'runtime' }
	}

	private listRegisteredOperations(): RuntimeOperation[] {
		const out: RuntimeOperation[] = []
		for (const descriptor of this.registry.list()) {
			const op = this.registry.get(descriptor.id)
			if (op) out.push(op)
		}
		return out
	}

	private clearCatalogCache(): void {
		this.versionValue += 1
		this.catalogCacheVersion = -1
		this.catalogCache.clear()
	}

	private removeRegistration(id: string): void {
		const registration = this.registrations.get(id)
		if (!registration) return
		this.registrations.delete(id)
		registration.cli?.dispose()
		registration.core.dispose()
		this.owners.delete(id)
		this.metadataById.delete(id)
		this.clearCatalogCache()
	}

	private assertReservedNamespace(
		op: RuntimeOperation,
		owner: string,
		metadata: RuntimeOpMetadata,
	): void {
		if (owner.startsWith('runtime:')) return

		const reservedIdPrefix = RESERVED_RUNTIME_OP_PREFIXES.find((prefix) => op.id.startsWith(prefix))
		if (reservedIdPrefix) {
			throw new Error(
				`Operation id "${op.id}" uses reserved runtime namespace "${reservedIdPrefix}"`,
			)
		}

		const toolName = metadata.mcp ? (metadata.mcp.name ?? op.id) : undefined
		if (toolName) {
			const reservedToolPrefix = RESERVED_MCP_TOOL_NAME_PREFIXES.find((prefix) =>
				toolName.startsWith(prefix),
			)
			if (reservedToolPrefix) {
				throw new Error(
					`MCP tool name "${toolName}" uses reserved runtime namespace "${reservedToolPrefix}"`,
				)
			}
		}

		const triggers = metadata.cli?.triggers ?? []
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
