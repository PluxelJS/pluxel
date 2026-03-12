import type { RpcStub } from 'capnweb'
import { treaty } from '@elysiajs/eden'

import {
	type AuthAwareFetchOptions,
	createAuthAwareFetch,
	defaultOnAuthBlocked,
	type HmrFetch,
	toGlobalFetch,
} from './auth'
import {
	type EdenResultLike,
	type HmrAuthMeta,
	type HmrInternalMeta,
	type HmrLogRangeQuery,
	type HmrStreamIndex,
	type HmrTreatyClient,
} from './client-contract'
import type { LogRangeResult, LogStreamMeta } from './logs'
import type { ExtensionManifest } from './plugin-ui'
import type { HmrRpcApi, UI } from './protocol'
import { createRpcClientFactory, createUiRpcView, invokeRpc } from './rpc'
import { type SseClientOptions, type SseClientWithNamespaces, sse } from './sse'
import {
	HMR_EXTENSIONS_EVENTS_PATH,
	HMR_INTERNAL_API_BASE,
	HMR_META_AUTH_PATH,
	HMR_TRANSPORT_PATHS,
	hmrLogStreamPath,
	joinPath,
} from './paths'
import { mergeNamespaces } from './utils'

export type {
	HmrAuthMeta,
	HmrInternalMeta,
	HmrLogRangeQuery,
	HmrStreamIndex,
} from './client-contract'

export type HmrWebClientOptions = {
	origin?: string
	apiBase?: string
	rpcBase?: string
	sse?: SseClientOptions
	defaultNamespace?: string
	credentials?: RequestCredentials
	fetch?: HmrFetch
	auth?: AuthAwareFetchOptions & {
		enabled?: boolean
	}
}

export interface HmrHttpApi {
	meta: {
		info(init?: RequestInit): Promise<HmrInternalMeta>
		auth(init?: RequestInit): Promise<HmrAuthMeta>
	}
	extensions: {
		manifest(init?: RequestInit): Promise<ExtensionManifest>
	}
	logs: {
		streams(init?: RequestInit): Promise<HmrStreamIndex>
		meta(streamId: string, init?: RequestInit): Promise<LogStreamMeta>
		range(streamId: string, query?: HmrLogRangeQuery, init?: RequestInit): Promise<LogRangeResult>
		followUrl(streamId: string, query?: URLSearchParams | string): string
	}
}

export interface HmrTransportLinks {
	apiBase: string
	rpc: string
	graphql: string
	sse: string
	mcp: string
	logsFollow(streamId: string, query?: URLSearchParams | string): string
	extensionEvents(namespaces?: string[]): string
}

export interface HmrWebClient {
	fetch: HmrFetch
	api: HmrHttpApi
	transport: HmrTransportLinks
	ui: UI.rpc
	withRpc: <T>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>) => Promise<T>
	createSse: (options?: SseClientOptions) => SseClientWithNamespaces
	sse: SseClientWithNamespaces
	dispose: () => void
}

function createHmrTreatyClient(
	transport: HmrTransportLinks,
	fetch: HmrFetch,
): HmrTreatyClient {
	// Keep the Treaty surface locally typed without importing the server project into this composite TS project.
	return treaty(transport.apiBase, {
		fetcher: toGlobalFetch(fetch),
	}) as unknown as HmrTreatyClient
}

function createHmrHttpApi(http: HmrTreatyClient, transport: HmrTransportLinks): HmrHttpApi {
	return {
		meta: {
			info: (init) => expectData<HmrInternalMeta>(http.meta.get({ fetch: init })),
			auth: (init) => expectData<HmrAuthMeta>(http.meta.auth.get({ fetch: init })),
		},
		extensions: {
			manifest: (init) =>
				expectData<ExtensionManifest>(http.extensions.manifest.get({ fetch: init })),
		},
		logs: {
			streams: (init) =>
				expectData<HmrStreamIndex>(http.logs.v1.streams.get({ fetch: init })),
			meta: (streamId, init) =>
				expectData<LogStreamMeta>(http.logs.v1.streams({ streamId }).meta.get({ fetch: init })),
			range: (streamId, query, init) =>
				expectData<LogRangeResult>(
					http.logs.v1.streams({ streamId }).range.get({
						query,
						fetch: init,
					}),
				),
			followUrl: (streamId, query) => transport.logsFollow(streamId, query),
		},
	}
}

function isAbsoluteUrl(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)
}

function resolveClientUrl(value: string): string {
	if (isAbsoluteUrl(value)) return value
	if (typeof window === 'undefined') return value
	return new URL(value, window.location.origin).toString()
}

function resolveApiBase(options: HmrWebClientOptions): string {
	return resolveClientUrl(
		options.apiBase ??
		(typeof options.origin === 'string' && options.origin
			? joinPath(options.origin, HMR_INTERNAL_API_BASE)
			: HMR_INTERNAL_API_BASE),
	)
}

function resolveBaseFetch(options: HmrWebClientOptions): HmrFetch {
	const fetchImpl =
		options.fetch ??
		(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
	if (!fetchImpl) {
		throw new Error('[hmr-web] global fetch is unavailable; pass `options.fetch` explicitly.')
	}
	return fetchImpl
}

function withDefaultCredentials(baseFetch: HmrFetch, credentials: RequestCredentials): HmrFetch {
	return (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.credentials !== undefined) return baseFetch(input as any, init as any)
		const isRequest = typeof Request === 'function' && input instanceof Request
		if (!init && isRequest) return baseFetch(input as any, init as any)
		return baseFetch(input as any, { ...(init ?? {}), credentials } as any)
	}
}

export function createHmrFetch(options: HmrWebClientOptions = {}): HmrFetch {
	const credentials: RequestCredentials = options.credentials ?? 'same-origin'
	const baseFetch = withDefaultCredentials(resolveBaseFetch(options), credentials)
	if (options.auth?.enabled === false) return baseFetch
	return createAuthAwareFetch(baseFetch, {
		onBlocked: options.auth?.onBlocked ?? defaultOnAuthBlocked,
		requireMarkerHeader: options.auth?.requireMarkerHeader,
	})
}

export function createHmrTransport(options: HmrWebClientOptions = {}): HmrTransportLinks {
	const apiBase = resolveApiBase(options)
	const transport = {
		apiBase,
		rpc: resolveClientUrl(options.rpcBase ?? joinPath(apiBase, HMR_TRANSPORT_PATHS.rpc)),
		graphql: resolveClientUrl(joinPath(apiBase, HMR_TRANSPORT_PATHS.graphql)),
		sse: resolveClientUrl(joinPath(apiBase, HMR_TRANSPORT_PATHS.sse)),
		mcp: resolveClientUrl(joinPath(apiBase, HMR_TRANSPORT_PATHS.mcp)),
		logsFollow: (streamId: string, query?: URLSearchParams | string) => {
			const base = resolveClientUrl(joinPath(apiBase, hmrLogStreamPath(streamId, '/follow')))
			const suffix =
				query instanceof URLSearchParams ? query.toString() : typeof query === 'string' ? query : ''
			return suffix ? `${base}?${suffix}` : base
		},
		extensionEvents: (namespaces?: string[]) => {
			const base = resolveClientUrl(joinPath(apiBase, HMR_EXTENSIONS_EVENTS_PATH))
			const params = new URLSearchParams()
			for (const namespace of namespaces ?? []) params.append('ns', namespace)
			const suffix = params.toString()
			return suffix ? `${base}?${suffix}` : base
		},
	}
	return transport
}

export async function expectData<T>(promise: Promise<EdenResultLike<T>>): Promise<T> {
	const result = await promise
	if (result.error) {
		if (result.error instanceof Error) throw result.error
		const status = result.response?.status
		throw new Error(status ? `HTTP ${status}` : 'Request failed')
	}
	if (result.data === null || result.data === undefined) {
		const status = result.response?.status
		throw new Error(status ? `HTTP ${status}` : 'Empty response')
	}
	return result.data
}

export function createHmrWebClient(options: HmrWebClientOptions = {}): HmrWebClient {
	const fetch = createHmrFetch(options)
	const transport = createHmrTransport(options)
	const http = createHmrTreatyClient(transport, fetch)
	const api = createHmrHttpApi(http, transport)
	const baseSseOptions = options.sse ?? {}
	const defaultNamespaces = options.defaultNamespace ? [options.defaultNamespace] : undefined
	const credentials: RequestCredentials = options.credentials ?? 'same-origin'
	const authEnabled = options.auth?.enabled !== false
	const rawRpc = createRpcClientFactory(transport.rpc)
	const ui = createUiRpcView(rawRpc, { credentials })
	const withRpc = <T>(runner: (client: RpcStub<HmrRpcApi>) => Promise<T>) =>
		invokeRpc(runner, { rpcBase: transport.rpc, credentials })

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
			url: opts?.url ?? baseSseOptions.url ?? transport.sse,
			withCredentials,
			auth: authEnabled
				? {
						metaUrl: joinPath(transport.apiBase, HMR_META_AUTH_PATH),
						fetch,
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

	return {
		fetch,
		api,
		transport,
		ui,
		withRpc,
		createSse,
		get sse() {
			return getSse()
		},
		dispose: () => {
			if (!memoSse) return
			memoSse.close()
			memoSse = null
		},
	}
}
