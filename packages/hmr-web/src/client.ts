import type { RpcStub } from 'capnweb'
import { hc } from 'hono/client'
import { type AuthAwareFetchOptions, createAuthAwareFetch, defaultOnAuthBlocked } from './auth'
import { HMR_INTERNAL_API_BASE, joinPath } from './paths'
import type { HmrRpcApi, UI } from './protocol'
import { createRpcClientFactory, createUiRpcView, invokeRpc } from './rpc'
import { type SseClientOptions, type SseClientWithNamespaces, sse } from './sse'
import { mergeNamespaces } from './utils'

export type HmrWebClientOptions = {
	/** Backend origin, e.g. `http://localhost:8787`. */
	origin?: string
	apiBase?: string
	rpcBase?: string
	sse?: SseClientOptions
	defaultNamespace?: string
	/** Default credentials for API fetch/RPC; defaults to `same-origin`. */
	credentials?: RequestCredentials
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
	/** UI extension RPC surface (declaration-merged via `@pluxel/hmr-web`). */
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
	const apiBase =
		options.apiBase ??
		(typeof options.origin === 'string' && options.origin
			? joinPath(options.origin, HMR_INTERNAL_API_BASE)
			: HMR_INTERNAL_API_BASE)
	const rpcBase = options.rpcBase ?? joinPath(apiBase, '/rpc')
	const baseSseOptions = options.sse ?? {}
	const defaultNamespaces = options.defaultNamespace ? [options.defaultNamespace] : undefined
	const credentials: RequestCredentials = options.credentials ?? 'same-origin'

	const baseFetch =
		options.fetch ??
		(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
	if (!baseFetch) {
		throw new Error('[hmr-web] global fetch is unavailable; pass `options.fetch` explicitly.')
	}

	const credentialedFetch: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.credentials !== undefined) return baseFetch(input as any, init as any)
		// Avoid overriding Request's own credentials when no init is provided.
		const isRequest = typeof Request === 'function' && input instanceof Request
		if (!init && isRequest) return baseFetch(input as any, init as any)
		return baseFetch(input as any, { ...(init ?? {}), credentials } as any)
	}

	const authEnabled = options.auth?.enabled !== false
	const authFetch = authEnabled
		? createAuthAwareFetch(credentialedFetch, {
				onBlocked: options.auth?.onBlocked ?? defaultOnAuthBlocked,
				requireMarkerHeader: options.auth?.requireMarkerHeader,
			})
		: credentialedFetch

	const api = hc(apiBase, { fetch: authFetch })
	const rawRpc = createRpcClientFactory(rpcBase)
	const ui = createUiRpcView(rawRpc, { credentials })
	const withRpc = <T>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>) =>
		invokeRpc(runner, { rpcBase, credentials })

	const baseNamespaces = mergeNamespaces(baseSseOptions.namespaces, defaultNamespaces)

	const buildSseOptions = (opts?: SseClientOptions, inheritNamespaces = true): SseClientOptions => {
		const params = { ...(baseSseOptions.params ?? {}), ...(opts?.params ?? {}) }
		const namespaces = inheritNamespaces
			? mergeNamespaces(baseNamespaces, opts?.namespaces)
			: mergeNamespaces(opts?.namespaces)
		const withCredentials =
			opts?.withCredentials ??
			baseSseOptions.withCredentials ??
			(credentials === 'include' ? true : undefined)

		return {
			...baseSseOptions,
			...opts,
			url: opts?.url ?? baseSseOptions.url ?? joinPath(apiBase, '/sse'),
			withCredentials,
			auth: authEnabled
				? {
						metaUrl: joinPath(apiBase, '/auth/meta'),
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
