import { newHttpBatchRpcSession, type RpcPromise } from 'capnweb'
import type {
	GatewayAuthContext,
	GatewayBillingContext,
} from '@repo/external-api-gateway-shared/gateway'
import {
	listExternalGatewayToolSpecs,
	type ExternalGatewayToolBatchCallInput,
	type ExternalGatewayToolBatchCallResult,
	type ExternalGatewayToolCallInput,
	type ExternalGatewayToolArgs,
	type ExternalGatewayJsonSchema,
	type ExternalGatewayToolListInput,
	type ExternalGatewayToolName,
	type ExternalGatewayToolResult,
	type ExternalGatewayToolSpec,
	type YiqichaBundleRecommendation,
} from './tools.ts'

export const DEFAULT_EXTERNAL_GATEWAY_RPC_URL =
	'http://127.0.0.1:3313/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc'

const disposeSymbol = (Symbol as unknown as { dispose?: symbol }).dispose
const asyncDisposeSymbol = (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose

export type PiToolDefinition = {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: ExternalGatewayJsonSchema
	}
}

export type PiExtensionOptions = {
	token: string
	rpcUrl?: string
	billing?: GatewayBillingContext | string
	tools?: ExternalGatewayToolListInput
	transport?: ExternalGatewayRpcTransport
}

export type PiToolCallOptions = {
	billing?: GatewayBillingContext | string
}

export type PiToolBatchCallRequest = {
	name: ExternalGatewayToolName | string
	args?: Record<string, unknown> | null
	billing?: GatewayBillingContext | string
}

export type YiqichaBundleCallOptions = {
	billing?: GatewayBillingContext | string
	noCache?: boolean
	only?: string[]
}

export type PiToolCallRequest = {
	id?: string
	name?: string
	tool?: string
	toolName?: string
	function?: {
		name?: string
		arguments?: Record<string, unknown> | string | null
	}
	args?: Record<string, unknown> | null
	arguments?: Record<string, unknown> | string | null
	billing?: GatewayBillingContext | string
}

export type PiToolCallResult = {
	toolCallId?: string
	name: string
	result: unknown
}

export type PiExtensionHealth = {
	ok: boolean
	rpcUrl: string
	authenticated: boolean
	localToolCount: number
	remoteToolCount?: number
	toolNames?: string[]
	tokenId?: string
	tokenName?: string
	error?: string
}

export type PiPlugin = {
	tools: PiToolDefinition[]
	getTools(input?: ExternalGatewayToolListInput): Promise<PiToolDefinition[]>
	refreshTools(input?: ExternalGatewayToolListInput): Promise<PiToolDefinition[]>
	callTool<N extends ExternalGatewayToolName>(
		name: N,
		args: ExternalGatewayToolArgs[N],
		options?: PiToolCallOptions,
	): Promise<ExternalGatewayToolResult[N]>
	callTool(
		name: string,
		args?: Record<string, unknown>,
		options?: PiToolCallOptions,
	): Promise<unknown>
	callTools(calls: PiToolBatchCallRequest[]): Promise<ExternalGatewayToolBatchCallResult>
	batch(): RpcPromise<ExternalGatewayAuthedRpc>
	handleToolCall(input: PiToolCallRequest): Promise<PiToolCallResult>
	handleToolCalls(input: PiToolCallRequest[]): Promise<PiToolCallResult[]>
	test(input?: ExternalGatewayToolListInput): Promise<PiExtensionHealth>
	dispose(): void
}

type Awaitable<T> = T | Promise<T>

export type ExternalGatewayAuthedRpc = {
	whoami(): Awaitable<GatewayAuthContext>
	toolSpecs(input?: ExternalGatewayToolListInput): Awaitable<ExternalGatewayToolSpec[]>
	callTool(input: ExternalGatewayToolCallInput): Awaitable<unknown>
	callTools(input: ExternalGatewayToolBatchCallInput): Awaitable<ExternalGatewayToolBatchCallResult>
}

export type ExternalGatewayRpcTransport = {
	authenticate(apiToken: string): Awaitable<ExternalGatewayAuthedRpc>
}

type DisposableRpcTransport = ExternalGatewayRpcTransport & {
	[key: symbol]: unknown
	dispose?: () => void | Promise<void>
}

export class PiExtension implements PiPlugin {
	readonly tools: PiToolDefinition[]
	readonly zhipu = {
		chat: (args: ExternalGatewayToolArgs['zhipu.chat'], options?: PiToolCallOptions) =>
			this.callTool('zhipu.chat', args, options),
		webSearch: (args: ExternalGatewayToolArgs['zhipu.web_search'], options?: PiToolCallOptions) =>
			this.callTool('zhipu.web_search', args, options),
		reader: (args: ExternalGatewayToolArgs['zhipu.reader'], options?: PiToolCallOptions) =>
			this.callTool('zhipu.reader', args, options),
		rerank: (args: ExternalGatewayToolArgs['zhipu.rerank'], options?: PiToolCallOptions) =>
			this.callTool('zhipu.rerank', args, options),
		embeddings: (args: ExternalGatewayToolArgs['zhipu.embeddings'], options?: PiToolCallOptions) =>
			this.callTool('zhipu.embeddings', args, options),
		moderate: (args: ExternalGatewayToolArgs['zhipu.moderate'], options?: PiToolCallOptions) =>
			this.callTool('zhipu.moderate', args, options),
	}
	readonly yiqicha = {
		findApis: (args: ExternalGatewayToolArgs['yiqicha.find_apis'], options?: PiToolCallOptions) =>
			this.callTool('yiqicha.find_apis', args, options),
		describeApi: (
			args: ExternalGatewayToolArgs['yiqicha.describe_api'],
			options?: PiToolCallOptions,
		) => this.callTool('yiqicha.describe_api', args, options),
		callApi: (args: ExternalGatewayToolArgs['yiqicha.call_api'], options?: PiToolCallOptions) =>
			this.callTool('yiqicha.call_api', args, options),
		recommendBundle: (
			args: ExternalGatewayToolArgs['yiqicha.recommend_bundle'],
			options?: PiToolCallOptions,
		) => this.callTool('yiqicha.recommend_bundle', args, options),
	}

	private readonly token: string
	private readonly rpcUrl: string
	private readonly transport?: DisposableRpcTransport
	private readonly defaultBilling: GatewayBillingContext | string
	private readonly defaultTools?: ExternalGatewayToolListInput
	private readonly cacheAuthedApi: boolean
	private authedApi?: Promise<ExternalGatewayAuthedRpc>

	constructor(options: PiExtensionOptions) {
		const token = options.token.trim()
		if (!token) throw new Error('PiExtension token is required')
		this.token = token
		this.rpcUrl = options.rpcUrl ?? DEFAULT_EXTERNAL_GATEWAY_RPC_URL
		this.defaultBilling = options.billing ?? 'pi-agent'
		this.defaultTools = options.tools
		this.cacheAuthedApi = Boolean(options.transport)
		this.transport = options.transport as DisposableRpcTransport | undefined
		this.tools = toPiToolDefinitions(listExternalGatewayToolSpecs(options.tools))
	}

	getTools(input?: ExternalGatewayToolListInput): Promise<PiToolDefinition[]> {
		return input ? this.refreshTools(input) : Promise.resolve(this.tools)
	}

	async refreshTools(
		input: ExternalGatewayToolListInput = this.defaultTools ?? {},
	): Promise<PiToolDefinition[]> {
		const specs = await this.callAuthed((api) => api.toolSpecs(input))
		return toPiToolDefinitions(specs)
	}

	callTool<N extends ExternalGatewayToolName>(
		name: N,
		args: ExternalGatewayToolArgs[N],
		options?: PiToolCallOptions,
	): Promise<ExternalGatewayToolResult[N]>
	callTool(
		name: string,
		args?: Record<string, unknown>,
		options?: PiToolCallOptions,
	): Promise<unknown>
	async callTool(
		name: string,
		args: Record<string, unknown> = {},
		options: PiToolCallOptions = {},
	): Promise<unknown> {
		const toolName = externalGatewayToolNameFromPiName(name)
		return this.callAuthed((api) =>
			api.callTool({
				name: toolName,
				args,
				billing: options.billing ?? this.defaultBilling,
			}),
		)
	}

	async callTools(calls: PiToolBatchCallRequest[]): Promise<ExternalGatewayToolBatchCallResult> {
		return this.callAuthed((api) =>
			api.callTools({
				calls: calls.map((call) => ({
					name: externalGatewayToolNameFromPiName(call.name),
					args: call.args,
					billing: call.billing ?? this.defaultBilling,
				})),
			}),
		)
	}

	batch(): RpcPromise<ExternalGatewayAuthedRpc> {
		const transport = newHttpBatchRpcSession<ExternalGatewayRpcTransport>(this.rpcUrl)
		return transport.authenticate(this.token) as RpcPromise<ExternalGatewayAuthedRpc>
	}

	async handleToolCall(input: PiToolCallRequest): Promise<PiToolCallResult> {
		const name = toolCallName(input)
		const result = await this.callTool(name, toolCallArgs(input), { billing: input.billing })
		return {
			toolCallId: input.id,
			name,
			result,
		}
	}

	async handleToolCalls(input: PiToolCallRequest[]): Promise<PiToolCallResult[]> {
		const batch = await this.callTools(
			input.map((call) => ({
				name: toolCallName(call),
				args: toolCallArgs(call),
				billing: call.billing,
			})),
		)
		return batch.results.map((item) => {
			if (!item.ok) throw new Error(item.error || `Tool call failed: ${item.name}`)
			return {
				toolCallId: input[item.index]?.id,
				name: item.name,
				result: item.result,
			}
		})
	}

	async test(
		input: ExternalGatewayToolListInput = this.defaultTools ?? {},
	): Promise<PiExtensionHealth> {
		try {
			const [identity, remoteSpecs] = await this.callAuthed((authedApi) =>
				Promise.all([authedApi.whoami(), authedApi.toolSpecs(input)]),
			)
			return {
				ok: true,
				rpcUrl: this.rpcUrl,
				authenticated: true,
				localToolCount: this.tools.length,
				remoteToolCount: remoteSpecs.length,
				toolNames: remoteSpecs.map((tool) => tool.name),
				tokenId: identity.tokenId,
				tokenName: identity.name,
			}
		} catch (caught) {
			return {
				ok: false,
				rpcUrl: this.rpcUrl,
				authenticated: false,
				localToolCount: this.tools.length,
				error: errorMessage(caught),
			}
		}
	}

	dispose(): void {
		if (this.transport) void disposeRpcTransport(this.transport)
	}

	private getAuthedApi(): Promise<ExternalGatewayAuthedRpc> {
		if (!this.transport) throw new Error('PiExtension transport is not configured')
		if (!this.authedApi) {
			this.authedApi = Promise.resolve()
				.then(() => this.transport.authenticate(this.token))
				.catch((caught) => {
					this.authedApi = undefined
					throw caught
				})
		}
		return this.authedApi
	}

	private async callAuthed<T>(
		callback: (api: ExternalGatewayAuthedRpc) => T | Promise<T>,
	): Promise<T> {
		if (this.cacheAuthedApi) return callback(await this.getAuthedApi())

		const transport = newHttpBatchRpcSession<ExternalGatewayRpcTransport>(
			this.rpcUrl,
		) as unknown as DisposableRpcTransport
		try {
			const api = transport.authenticate(this.token) as ExternalGatewayAuthedRpc
			return await callback(api)
		} finally {
			await disposeRpcTransport(transport)
		}
	}
}

export const externalGatewayPiTools: PiToolDefinition[] = toPiToolDefinitions(
	listExternalGatewayToolSpecs(),
)

export function yiqichaBundleCalls(
	plan: YiqichaBundleRecommendation,
	options: YiqichaBundleCallOptions = {},
): PiToolBatchCallRequest[] {
	const only = options.only?.length ? new Set(options.only) : undefined
	return plan.calls
		.filter((call) => !only || only.has(call.id))
		.map((call) => ({
			name: 'yiqicha.call_api',
			args: {
				api: call.api,
				params: call.params,
				...(options.noCache === undefined ? {} : { noCache: options.noCache }),
			},
			...(options.billing === undefined ? {} : { billing: options.billing }),
		}))
}

export function toPiToolDefinition(spec: ExternalGatewayToolSpec): PiToolDefinition {
	return {
		type: 'function',
		function: {
			name: externalGatewayToolNameToPiName(spec.name),
			description: spec.description,
			parameters: spec.inputSchema,
		},
	}
}

function toPiToolDefinitions(specs: ExternalGatewayToolSpec[]): PiToolDefinition[] {
	return specs.map(toPiToolDefinition)
}

function toolCallName(input: PiToolCallRequest): string {
	const name = input.name ?? input.toolName ?? input.tool ?? input.function?.name
	if (!name?.trim()) throw new Error('PI tool call name is required')
	return externalGatewayToolNameFromPiName(name.trim())
}

export function externalGatewayToolNameToPiName(name: ExternalGatewayToolName): string {
	return name.replaceAll('.', '_')
}

export function externalGatewayToolNameFromPiName(name: string): string {
	return piToolNameToGatewayName.get(name) ?? name
}

const piToolNameToGatewayName = new Map<string, ExternalGatewayToolName>(
	listExternalGatewayToolSpecs().flatMap((spec) => [
		[spec.name, spec.name],
		[externalGatewayToolNameToPiName(spec.name), spec.name],
	]),
)

function toolCallArgs(input: PiToolCallRequest): Record<string, unknown> {
	const args = input.args ?? input.arguments ?? input.function?.arguments ?? {}
	if (typeof args === 'string') {
		const parsed = JSON.parse(args) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('PI tool call arguments must be a JSON object')
		}
		return parsed as Record<string, unknown>
	}
	if (!args || typeof args !== 'object' || Array.isArray(args)) {
		throw new Error('PI tool call arguments must be an object')
	}
	return args
}

function errorMessage(caught: unknown): string {
	if (caught instanceof Error) return caught.message
	return String(caught)
}

async function disposeRpcTransport(transport: DisposableRpcTransport): Promise<void> {
	const dispose =
		(disposeSymbol ? transport[disposeSymbol] : undefined) ??
		(asyncDisposeSymbol ? transport[asyncDisposeSymbol] : undefined) ??
		transport.dispose
	if (typeof dispose !== 'function') return
	try {
		await dispose.call(transport)
	} catch {}
}
