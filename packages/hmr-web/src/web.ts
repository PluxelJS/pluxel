import type { RpcStub } from 'capnweb'
import type { HmrRpcApi, RpcExtensions } from './protocol'
import { createRpcClientFactory, createRpcExtensionsView } from './rpc'
import { mergeNamespaces } from './utils'
import { sse, type SseClientOptions, type SseClientWithNamespaces } from './sse'
import { hc } from 'hono/client'

export type HmrWebClientOptions = {
	apiBase?: string
	rpcBase?: string
	sse?: SseClientOptions
	defaultNamespace?: string
}

export interface HmrWebClient {
	api: ReturnType<typeof hc>
	rawRpc: () => RpcStub<HmrRpcApi>
	rpc: RpcExtensions
	createSse: (options?: SseClientOptions) => SseClientWithNamespaces
	sse: SseClientWithNamespaces
	streamLogs: (
		options?: Omit<SseClientOptions, 'namespaces'> & { name?: string },
	) => SseClientWithNamespaces
	streamExtensions: (options?: Omit<SseClientOptions, 'namespaces'>) => SseClientWithNamespaces
	dispose: () => void
}

export function createHmrWebClient(options: HmrWebClientOptions = {}): HmrWebClient {
	const apiBase = options.apiBase ?? '/api'
	const rpcBase = options.rpcBase ?? '/api/rpc'
	const baseSseOptions = options.sse ?? {}
	const defaultNamespaces = options.defaultNamespace ? [options.defaultNamespace] : undefined

	const api = hc(apiBase)
	const rawRpc = createRpcClientFactory(rpcBase)
	const rpc = createRpcExtensionsView(rawRpc)

	const baseNamespaces = mergeNamespaces(baseSseOptions.namespaces, defaultNamespaces)

	const buildSseOptions = (opts?: SseClientOptions, inheritNamespaces = true): SseClientOptions => {
		const params = { ...(baseSseOptions.params ?? {}), ...(opts?.params ?? {}) }
		const namespaces = inheritNamespaces
			? mergeNamespaces(baseNamespaces, opts?.namespaces)
			: mergeNamespaces(opts?.namespaces)

		return {
			...baseSseOptions,
			...opts,
			url: opts?.url ?? baseSseOptions.url ?? '/api/sse',
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
		rpc,
		createSse,
		get sse() {
			return getSse()
		},
		streamLogs,
		streamExtensions,
		dispose,
	}
}

export const hmrWebClient = createHmrWebClient()

export const client = hmrWebClient.api
