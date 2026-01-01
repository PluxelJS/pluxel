import type { RpcStub } from 'capnweb'
import type { HmrRpcApi, UI } from './protocol'
import { createAuthAwareFetch, defaultOnAuthBlocked, type AuthAwareFetchOptions } from './auth'
import { createRpcClientFactory, createRpcExtensionsView, invokeRpc } from './rpc'
import { mergeNamespaces } from './utils'
import { sse, type SseClientOptions, type SseClientWithNamespaces } from './sse'
import { hc } from 'hono/client'

export type HmrWebClientOptions = {
	apiBase?: string
	rpcBase?: string
	sse?: SseClientOptions
	defaultNamespace?: string
	/**
	 * Custom fetch implementation (defaults to global fetch).
	 * If `auth` is enabled, this fetch will be wrapped.
	 */
	fetch?: typeof fetch
	/**统一鉴权失败处理（401/403 + redirectPath）。*/
	auth?: AuthAwareFetchOptions & {
		/** 是否启用 auth-aware fetch 包装（默认启用）。 */
		enabled?: boolean
		/**
		 * 是否在 React Provider 中对 globalThis.fetch 打补丁（默认不启用）。
		 * 建议仅在代码里大量直接用 `fetch()` 且希望统一重定向时启用。
		 */
		globalFetch?: boolean
	}
}

export interface HmrWebClient {
	api: ReturnType<typeof hc>
	rpc: UI.rpc
	withRpc: <T>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>) => Promise<T>
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

	const baseFetch =
		options.fetch ??
		(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
	if (!baseFetch) {
		throw new Error('[hmr-web] global fetch is unavailable; pass `options.fetch` explicitly.')
	}

	const authEnabled = options.auth?.enabled !== false
	const authFetch = authEnabled
		? createAuthAwareFetch(baseFetch, {
				onBlocked: options.auth?.onBlocked ?? defaultOnAuthBlocked,
				requireMarkerHeader: options.auth?.requireMarkerHeader,
			})
		: baseFetch

	const api = hc(apiBase, { fetch: authFetch })
	const rawRpc = createRpcClientFactory(rpcBase)
	const rpc = createRpcExtensionsView(rawRpc)
	const withRpc = <T,>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>) =>
		invokeRpc(runner, { rpcBase })

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
			auth: authEnabled
				? {
						metaUrl: `${apiBase}/auth/meta`,
						fetch: authFetch,
						onBlocked: options.auth?.onBlocked ?? defaultOnAuthBlocked,
					}
				: undefined,
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
		rpc,
		withRpc,
		createSse,
		get sse() {
			return getSse()
		},
		streamLogs,
		streamExtensions,
		dispose,
	}
}

let _defaultClient: HmrWebClient | null = null

/**
 * Lazily create a shared default client (no side effects until first call).
 *
 * If you pass options, it always creates a new client (not memoized).
 */
export function getHmrWebClient(options?: HmrWebClientOptions): HmrWebClient {
	if (options) return createHmrWebClient(options)
	if (!_defaultClient) _defaultClient = createHmrWebClient()
	return _defaultClient
}

export function disposeHmrWebClient(): void {
	if (!_defaultClient) return
	_defaultClient.dispose()
	_defaultClient = null
}
