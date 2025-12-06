import type { ExtensionContext, PluginUIModule } from '@pluxel/components'
import type { RpcStub } from 'capnweb'
import { newHttpBatchRpcSession } from 'capnweb'
import { hc, type InferRequestType, type InferResponseType } from 'hono/client'
import type { HmrRpcApi } from '../api/hono'
import type { AppType } from '../api/hono/index'
import type { RpcExtensions } from '../services'
import {
	type ResolvedSseEvents,
	type SseClientOptions,
	type SseClientWithNamespaces,
	type SseMessage,
	sse,
} from './sse'

export type { ExtensionContext }

/**
 * Helper to define a plugin UI module with full type inference.
 * ```ts
 * import { definePluginUIModule } from '@pluxel/hmr/web'
 *
 * export default definePluginUIModule({
 *   extensions: [...],
 * })
 * ```
 */
export function definePluginUIModule<T extends PluginUIModule>(module: T): T {
	return module
}

export type { InferRequestType, InferResponseType }

export const client = hc<AppType>('/api')

export const rawRpc = (): RpcStub<HmrRpcApi> => newHttpBatchRpcSession<HmrRpcApi>('/api/rpc')
export const createRpcClient = rawRpc
export const rpc = (): RpcExtensions => rawRpc().ext

export async function invokeRpc<T>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>): Promise<T> {
	const client = rawRpc()
	try {
		return await runner(client)
	} catch (error) {
		console.error('[Plugin RPC] 调用失败', error)
		throw error
	}
}

export function rpcErrorMessage(error: unknown, fallback = 'RPC 调用失败'): string {
	if (error instanceof Error) {
		return error.message || fallback
	}
	if (typeof error === 'string') {
		return error
	}
	return fallback
}

type WebClientOptions = {
	apiBase?: string
	rpcBase?: string
	sse?: SseClientOptions
	/**
	 * 默认插件命名空间（通常等于插件名），便于快速创建 SSE client。
	 * createSse() 会自动附加到 namespaces。
	 */
	defaultNamespace?: string
}

export interface HmrWebClient {
	api: ReturnType<typeof hc<AppType>>
	rawRpc: () => RpcStub<HmrRpcApi>
	rpc: RpcExtensions
	createSse: (options?: SseClientOptions) => SseClientWithNamespaces
	/** 预配置的 SSE 客户端，可直接点出命名空间（无需再传 namespaces） */
	sse: SseClientWithNamespaces
	streamLogs: (
		options?: Omit<SseClientOptions, 'namespaces'> & { name?: string },
	) => SseClientWithNamespaces
	streamExtensions: (options?: Omit<SseClientOptions, 'namespaces'>) => SseClientWithNamespaces
	/** 手动回收单例 SSE，便于在宿主卸载时释放连接 */
	dispose: () => void
}

/**
 * 统一创建前端客户端：Rest/RPC/SSE。
 * - 支持自定义 api/rpc 基础路径
 * - 内置 logs/extensions 命名空间快速访问
 */
export function createHmrWebClient(options: WebClientOptions = {}): HmrWebClient {
	const apiBase = options.apiBase ?? '/api'
	const rpcBase = options.rpcBase ?? '/api/rpc'
	const baseSseOptions = options.sse ?? {}
	const defaultNamespaces = options.defaultNamespace ? [options.defaultNamespace] : undefined

	const api = hc<AppType>(apiBase)
	// Capnweb batch RPC sessions must be short-lived per call; reusing a closed
	// session will surface "Batch RPC request ended." errors in consumers.
	const rawRpc = () => newHttpBatchRpcSession<HmrRpcApi>(rpcBase)
	const baseNamespaces = mergeNamespaces(baseSseOptions.namespaces, defaultNamespaces)

	const buildSseOptions = (opts?: SseClientOptions, inheritNamespaces = true): SseClientOptions => {
		const params = { ...(baseSseOptions.params ?? {}), ...(opts?.params ?? {}) }
		const namespaces = inheritNamespaces
			? mergeNamespaces(baseNamespaces, opts?.namespaces)
			: mergeNamespaces(opts?.namespaces)

		return {
			...baseSseOptions,
			...opts,
			url: opts?.url ?? baseSseOptions.url ?? `${apiBase}/sse`,
			params,
			namespaces: namespaces.length ? namespaces : undefined,
		}
	}

	const createSse = (opts?: SseClientOptions) => sse(buildSseOptions(opts))

	let memoSse: SseClientWithNamespaces | null = null
	const getSse = () => {
		if (!memoSse) memoSse = createSse()
		return memoSse
	}

	const dispose = () => {
		if (!memoSse) return
		memoSse.close()
		memoSse = null
	}

	const streamLogs = (opts?: Omit<SseClientOptions, 'namespaces'> & { name?: string }) => {
		const params = { ...(baseSseOptions.params ?? {}), ...(opts?.params ?? {}) }
		if (opts?.name) params.name = opts.name
		return sse(buildSseOptions({ ...opts, params, namespaces: ['logs'] }, false))
	}

	const streamExtensions = (opts?: Omit<SseClientOptions, 'namespaces'>) => {
		return sse(buildSseOptions({ ...opts, namespaces: ['extensions'] }, false))
	}

	return {
		api,
		rawRpc,
		get rpc() {
			return rawRpc().ext
		},
		createSse,
		get sse() {
			return getSse()
		},
		streamLogs,
		streamExtensions,
		dispose,
	}
}

// 默认客户端：满足“开箱即用”的 .rpc/.sse 访问，不需要手动 new
export const webClient = createHmrWebClient()

// 前端 SSE 工具（带类型推导 + 命名空间代理）
export {
	sse,
	type ResolvedSseEvents,
	type SseClientOptions,
	type SseClientWithNamespaces,
	type SseMessage,
}

export type { HmrWebClient, WebClientOptions }

function mergeNamespaces(...lists: Array<string[] | undefined>): string[] {
	return Array.from(
		new Set(
			lists
				.flatMap((list) => list ?? [])
				.map((ns) => ns.trim())
				.filter(Boolean),
		),
	)
}
