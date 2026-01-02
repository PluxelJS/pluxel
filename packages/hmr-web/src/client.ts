import type { RpcStub } from 'capnweb'
import type { HmrRpcApi, UI } from './protocol'
import { createAuthAwareFetch, defaultOnAuthBlocked, type AuthAwareFetchOptions } from './auth'
import { createRpcClientFactory, createUiRpcView, invokeRpc } from './rpc'
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
	}
}

export interface HmrWebClient {
	api: ReturnType<typeof hc>
	/** UI extension RPC surface (declaration-merged via `@pluxel/hmr/services`). */
	ui: UI.rpc
	withRpc: <T>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>) => Promise<T>
	createSse: (options?: SseClientOptions) => SseClientWithNamespaces
	sse: SseClientWithNamespaces
	dispose: () => void
}

/**
 * Create a browser-side HMR client.
 *
 * - `withRpc()` creates a short-lived batch session per call.
 * - `ui` is a stable proxy that also creates a fresh session per method call.
 * - `sse` is memoized; call `dispose()` to close the shared connection.
 */
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
	const ui = createUiRpcView(rawRpc)
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

	return {
		api,
		ui,
		withRpc,
		createSse,
		get sse() {
			return getSse()
		},
		dispose,
	}
}
