import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
	type Tool,
	type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { TransformKind, type TObject } from '@sinclair/typebox'
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler'
import type { Context as CoreContext } from '@pluxel/core'
import { CALLER_CONTEXT_BIND, enterOwnerInvocation } from '@pluxel/core/internal'
import type { CommandContext, CommandFailure, DirectCommand, Registration } from '@pluxel/commands'
import { installOwnerViewCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { createCommandMount, type CommandMount } from '../commands/mount'
import { pinOwnerContext } from '../internal/owner-view'
import { JsonWireError, copyJson } from '../internal/json-wire'
import { Mcp } from './token'

export { Mcp } from './token'

export type McpRequest = Readonly<{
	authInfo?: AuthInfo
	sessionId?: string
	signal: AbortSignal
}>

export interface McpInstallOptions {
	/** A low-level SDK server whose transport and authentication are installed by the host. */
	readonly server: Server
	/** Resolve the already authenticated principal for each SDK request. */
	readonly authenticate: (request: McpRequest) => unknown | Promise<unknown>
	/** @defaultValue 1048576 */
	readonly maxOutputBytes?: number
}

type ReservedContext = 'signal' | 'deadlineMs' | 'meta'
type BusinessContext<Ctx extends CommandContext> = Omit<Ctx, ReservedContext> & {
	readonly signal?: never
	readonly deadlineMs?: never
	readonly meta?: never
}

type McpInvocation = Readonly<{ principal: unknown; signal: AbortSignal; deadlineMs?: number }>

export type McpExposeOptions<Ctx extends CommandContext> = Readonly<{
	context?: (invocation: McpInvocation) => BusinessContext<Ctx> | Promise<BusinessContext<Ctx>>
	authorize?: (
		invocation: Readonly<{ principal: unknown; name: string; signal: AbortSignal }>,
	) => boolean | Promise<boolean>
	annotations?: ToolAnnotations
	outputSchema?: TObject
}>

type RequiredOptions<Ctx extends CommandContext> = McpExposeOptions<Ctx> & {
	context: NonNullable<McpExposeOptions<Ctx>['context']>
}

type ToolRecord = {
	name: string
	owner: CoreContext
	active: boolean
	tool: Tool
	command: DirectCommand<any, unknown, any>
	context?: (invocation: McpInvocation) => unknown | Promise<unknown>
	authorize?: (invocation: {
		principal: unknown
		name: string
		signal: AbortSignal
	}) => boolean | Promise<boolean>
	outputCheck?: TypeCheck<TObject>
}

/** An owner-bound view over one explicitly installed MCP server. */
export class McpService {
	private readonly records = new Map<string, ToolRecord>()
	private readonly mount?: CommandMount<any>
	private readonly maxOutputBytes: number

	constructor(
		public readonly ctx: CoreContext,
		private readonly options: McpInstallOptions,
		private readonly rootService?: McpService,
	) {
		pinOwnerContext(this, ctx)
		this.maxOutputBytes = options.maxOutputBytes ?? 1_048_576
		if (rootService) return
		if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1) {
			throw new TypeError('MCP maxOutputBytes must be a positive integer')
		}
		this.mount = createCommandMount(this.ctx)
		this.installHandlers()
	}

	expose<I, O, Ctx extends CommandContext>(
		command: DirectCommand<I, O, Ctx>,
		...args: CommandContext extends Ctx
			? [options?: McpExposeOptions<Ctx>]
			: [options: RequiredOptions<Ctx>]
	): Registration {
		return this.root().exposeFor(this.ctx, command, args[0])
	}

	private root(): McpService {
		return this.rootService ?? this
	}

	private exposeFor<I, O, Ctx extends CommandContext>(
		owner: CoreContext,
		command: DirectCommand<I, O, Ctx>,
		options?: McpExposeOptions<Ctx>,
	): Registration {
		const root = this.root()
		if (root.records.has(command.name))
			throw new TypeError(`MCP tool already exposed: ${command.name}`)
		const outputSchema = options?.outputSchema
		let outputCheck: TypeCheck<TObject> | undefined
		if (outputSchema) {
			if (containsTransform(outputSchema))
				throw new TypeError('MCP outputSchema must not contain TypeBox Transform')
			outputCheck = TypeCompiler.Compile(outputSchema)
		}
		const annotations = options?.annotations ? { ...options.annotations } : undefined
		const tool: Tool = {
			name: command.name,
			description: command.descriptor.description,
			inputSchema: command.descriptor.inputSchema as Tool['inputSchema'],
			...(annotations ? { annotations } : {}),
			...(outputSchema
				? { outputSchema: JSON.parse(JSON.stringify(outputSchema)) as Tool['outputSchema'] }
				: {}),
		}
		let record: ToolRecord | undefined
		const mount = root.mount as CommandMount<any> & {
			[CALLER_CONTEXT_BIND](caller: CoreContext): CommandMount<any>
		}
		const bound = mount[CALLER_CONTEXT_BIND](owner)
		const registration = bound.bind(command as DirectCommand<I, O, any>, (owned) => {
			if (root.records.has(command.name))
				throw new TypeError(`MCP tool already exposed: ${command.name}`)
			tool.name = owned.name
			tool.description = owned.descriptor.description
			tool.inputSchema = owned.descriptor.inputSchema as Tool['inputSchema']
			record = {
				name: command.name,
				owner,
				active: false,
				tool,
				command: owned,
				context: options?.context,
				authorize: options?.authorize,
				outputCheck,
			}
			root.records.set(command.name, record)
			return {
				name: command.name,
				dispose: () => {
					if (!record) return
					record.active = false
					if (root.records.get(record.name) === record) {
						root.records.delete(record.name)
						root.notifyListChanged()
					}
				},
			}
		})
		if (record) {
			record.active = true
			Object.freeze(record.tool)
			root.notifyListChanged()
		}
		return registration
	}

	private notifyListChanged(): void {
		if (!this.options.server.transport) return
		void this.options.server
			.sendToolListChanged()
			.catch((error) => this.report('MCP tool list notification failed', error, 'tools/list'))
	}

	private installHandlers(): void {
		const { server } = this.options
		if (!(server instanceof Server) || typeof this.options.authenticate !== 'function') {
			throw new TypeError('MCP requires an SDK Server and authenticate callback')
		}
		server.registerCapabilities({ tools: { listChanged: true } })
		server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
			try {
				const principal = await this.authenticate({
					authInfo: extra.authInfo,
					sessionId: extra.sessionId,
					signal: extra.signal,
				})
				const visible: ToolRecord[] = []
				for (const record of this.records.values()) {
					if (!record.active) continue
					const release = this.enterOwners(record, extra.signal)
					try {
						if (!record.active) continue
						if (
							record.authorize &&
							!(await record.authorize({ principal, name: record.name, signal: release.signal }))
						)
							continue
						if (record.active) visible.push(record)
					} finally {
						release.dispose()
					}
				}
				return {
					tools: visible
						.filter((record) => record.active && this.records.get(record.name) === record)
						.map((record) => record.tool),
				}
			} catch (error) {
				this.report('MCP tool discovery failed', error, 'tools/list')
				throw new McpError(ErrorCode.InternalError, 'Tool discovery failed')
			}
		})
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const record = this.records.get(request.params.name)
			if (!record?.active) {
				try {
					await this.authenticate({
						authInfo: extra.authInfo,
						sessionId: extra.sessionId,
						signal: extra.signal,
					})
				} catch (error) {
					this.report('MCP request authentication failed', error, request.params.name)
					return toolError('INTERNAL', 'Tool failed')
				}
				return toolError('COMMAND_NOT_FOUND', 'Tool not found')
			}
			let principal: unknown
			try {
				principal = await this.authenticate({
					authInfo: extra.authInfo,
					sessionId: extra.sessionId,
					signal: extra.signal,
				})
			} catch (error) {
				this.report('MCP request authentication failed', error, record.name)
				return toolError('INTERNAL', 'Tool failed')
			}
			if (!record.active || this.records.get(record.name) !== record) {
				return toolError('PUBLICATION_GONE', 'Tool unavailable')
			}
			let release: ReturnType<McpService['enterOwners']>
			try {
				release = this.enterOwners(record, extra.signal)
			} catch {
				return toolError('ABORTED', 'Tool unavailable')
			}
			try {
				const business = snapshotBusinessContext(
					record.context ? await record.context({ principal, signal: release.signal }) : {},
				)
				const authorized = record.authorize
					? await record.authorize({ principal, name: record.name, signal: release.signal })
					: true
				if (!record.active || this.records.get(record.name) !== record || release.signal.aborted) {
					return toolError('PUBLICATION_GONE', 'Tool unavailable')
				}
				if (!authorized) return toolError('FORBIDDEN', 'Tool access denied')
				const result = await record.command.execute(request.params.arguments ?? {}, {
					...business,
					signal: release.signal,
				})
				if (result.isErr()) return this.projectFailure(result.error, record.name)
				return this.projectSuccess(result.value, record)
			} catch (error) {
				this.report('MCP tool invocation failed', error, record.name)
				return toolError('INTERNAL', 'Tool failed')
			} finally {
				release.dispose()
			}
		})
		try {
			this.ctx.effects.defer(
				() => {
					this.records.clear()
					server.removeRequestHandler('tools/list')
					server.removeRequestHandler('tools/call')
				},
				{ tag: 'McpServerHandlers' },
			)
		} catch (error) {
			server.removeRequestHandler('tools/list')
			server.removeRequestHandler('tools/call')
			throw error
		}
	}

	private async authenticate(request: McpRequest): Promise<unknown> {
		const principal = await this.options.authenticate(request)
		if (principal === null || principal === undefined) {
			throw new TypeError('MCP authentication returned no principal')
		}
		return principal
	}

	private enterOwners(
		record: ToolRecord,
		signal: AbortSignal,
	): { signal: AbortSignal; dispose(): void } {
		const provider = enterOwnerInvocation(this.ctx, signal)
		try {
			const publisher =
				record.owner === this.ctx ? undefined : enterOwnerInvocation(record.owner, provider.signal)
			return {
				signal: publisher?.signal ?? provider.signal,
				dispose: () => {
					publisher?.dispose()
					provider.dispose()
				},
			}
		} catch (error) {
			provider.dispose()
			throw error
		}
	}

	private projectSuccess(value: unknown, record: ToolRecord): CallToolResult {
		try {
			const projected = copyJson(value, this.maxOutputBytes)
			if (record.outputCheck) {
				if (
					!projected.value ||
					Array.isArray(projected.value) ||
					typeof projected.value !== 'object' ||
					!record.outputCheck.Check(projected.value)
				) {
					this.report(
						'MCP outputSchema rejected Command success',
						[...record.outputCheck.Errors(projected.value)]
							.slice(0, 5)
							.map(({ path, message }) => ({ path, message })),
						record.name,
					)
					return toolError('INTERNAL', 'Tool output failed validation')
				}
				return {
					content: [{ type: 'text', text: projected.text }],
					structuredContent: projected.value,
				}
			}
			return {
				content: [
					{
						type: 'text',
						text:
							typeof value === 'string'
								? value
								: value === undefined
									? 'Completed.'
									: projected.text,
					},
				],
			}
		} catch (error) {
			const code = error instanceof JsonWireError ? error.code : 'INTERNAL'
			this.report('MCP tool output failed', error, record.name)
			return toolError(
				code,
				code === 'OUTPUT_LIMIT' ? 'Tool output exceeds limit' : 'Tool output cannot be delivered',
			)
		}
	}

	private projectFailure(failure: CommandFailure, command: string): CallToolResult {
		const publicFailure = {
			code: failure.code,
			message: failure.message,
			...(failure.code === 'REJECTED' ? { reason: failure.reason } : {}),
			...(failure.code === 'INPUT_VALIDATION'
				? {
						issues: failure.issues.map((issue) => ({
							...(issue.path ? { path: issue.path } : {}),
							...(issue.code ? { code: issue.code } : {}),
							message: issue.message,
						})),
					}
				: {}),
		}
		try {
			return {
				isError: true,
				content: [{ type: 'text', text: copyJson(publicFailure, this.maxOutputBytes).text }],
			}
		} catch (error) {
			this.report('MCP command failure could not be delivered', error, command)
			return toolError(
				error instanceof JsonWireError ? error.code : 'INTERNAL',
				'Tool failure could not be delivered',
			)
		}
	}

	private report(message: string, error: unknown, command: string): void {
		try {
			this.ctx.logger.error(message, { error, command })
		} catch {
			/* diagnostics must not replace the result */
		}
	}
}

function snapshotBusinessContext(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('MCP context factory returned invalid business context')
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError('MCP context factory returned invalid business context')
	if (Object.getOwnPropertySymbols(value).length > 0)
		throw new TypeError('MCP context factory returned invalid business context')
	const snapshot: Record<string, unknown> = Object.create(null)
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (
			key === 'signal' ||
			key === 'deadlineMs' ||
			key === 'meta' ||
			!descriptor.enumerable ||
			!('value' in descriptor)
		) {
			throw new TypeError('MCP context factory returned invalid business context')
		}
		snapshot[key] = descriptor.value
	}
	return snapshot
}

function containsTransform(value: unknown, seen = new WeakSet<object>()): boolean {
	if (!value || typeof value !== 'object' || seen.has(value)) return false
	seen.add(value)
	if ((value as Record<PropertyKey, unknown>)[TransformKind] !== undefined) return true
	return Object.values(value).some((entry) => containsTransform(entry, seen))
}

function toolError(code: string, message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] }
}

/** Install MCP only when a host has already selected an authenticated SDK transport. */
export function mcp(options: McpInstallOptions) {
	return defineHostService({
		name: 'Mcp',
		capabilities: [
			installOwnerViewCapability(Mcp, {
				property: 'mcp',
				createRoot: (root) => new McpService(root as CoreContext, options),
				createView: (rootService, owner) =>
					owner === owner.root
						? rootService
						: new McpService(owner as CoreContext, options, rootService),
			}),
		],
	})
}
