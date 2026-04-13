import type { RpcStub } from 'capnweb'
import { treaty } from '@elysiajs/eden'

import {
	type AuthAwareFetchOptions,
	createAuthAwareFetch,
	defaultOnAuthBlocked,
	type RuntimeFetch,
	toGlobalFetch,
} from './auth'
import type { LogFilter, LogRangeResult, LogStreamMeta } from './logs'
import type { ExtensionManifest } from './extensions'
import type { ExtensionUiRpcMap, RuntimeRpcApi } from './protocol'
import { createRpcClientFactory, createUiRpcView, invokeRpc } from './rpc'
import { type SseClientOptions, type SseClientWithNamespaces, sse } from './sse'
import {
	HMR_EXTENSIONS_EVENTS_PATH,
	HMR_INTERNAL_API_BASE,
	HMR_META_AUTH_PATH,
	HMR_TRANSPORT_PATHS,
	hmrSignalDbCollectionPath,
	hmrLogStreamPath,
	joinPath,
} from './paths'
import { mergeNamespaces } from './utils'

export interface RuntimeAuthMeta {
	enabled: boolean
	pluginName: string | null
	redirectPath: string | null
	authenticated: boolean
}

export interface RuntimeMeta {
	service: 'pluxel-hmr'
	ready: true
	auth: RuntimeAuthMeta
	sse: {
		namespaces: string[]
	}
	extensions: {
		version: number
		modules: number
	}
	transport: {
		rpc: string
		graphql: string
		sse: string
		mcp: string
		signaldb: string
	}
}

export interface RuntimeLogStreamsIndex {
	streams: LogStreamMeta[]
}

export type RuntimeLogRangeQuery = LogFilter & {
	epoch?: number
	from?: string
	limit?: number
}

export type EdenResultLike<T = unknown> = {
	data: T | null
	error: unknown
	response?: Response
}

type RuntimeTreatyFetchOptions = {
	fetch?: RequestInit
}

type RuntimeTreatyQueryOptions<TQuery> = RuntimeTreatyFetchOptions & {
	query?: TQuery
}

type RuntimeTreatyGet<TData, TQuery = never> = {
	get(
		options?: [TQuery] extends [never]
			? RuntimeTreatyFetchOptions
			: RuntimeTreatyQueryOptions<TQuery>,
	): Promise<EdenResultLike<TData>>
}

type RuntimeTreatyStreamRoute = {
	meta: RuntimeTreatyGet<LogStreamMeta>
	range: RuntimeTreatyGet<LogRangeResult, RuntimeLogRangeQuery>
}

type RuntimeTreatyStreamsRoute = RuntimeTreatyGet<RuntimeLogStreamsIndex> &
	((params: { streamId: string }) => RuntimeTreatyStreamRoute)

interface RuntimeTreatyClient {
	meta: RuntimeTreatyGet<RuntimeMeta> & {
		auth: RuntimeTreatyGet<RuntimeAuthMeta>
	}
	extensions: {
		manifest: RuntimeTreatyGet<ExtensionManifest>
	}
	logs: {
		v1: {
			streams: RuntimeTreatyStreamsRoute
		}
	}
}

export type RuntimeTransportClientOptions = {
	origin?: string
	apiBase?: string
	rpcBase?: string
	sse?: SseClientOptions
	defaultNamespace?: string
	credentials?: RequestCredentials
	fetch?: RuntimeFetch
	auth?: AuthAwareFetchOptions & {
		enabled?: boolean
	}
}

type RuntimeTransportHttp = {
	meta: {
		info(init?: RequestInit): Promise<RuntimeMeta>
		auth(init?: RequestInit): Promise<RuntimeAuthMeta>
	}
	extensions: {
		manifest(init?: RequestInit): Promise<ExtensionManifest>
	}
	logs: {
		streams(init?: RequestInit): Promise<RuntimeLogStreamsIndex>
		meta(streamId: string, init?: RequestInit): Promise<LogStreamMeta>
		range(
			streamId: string,
			query?: RuntimeLogRangeQuery,
			init?: RequestInit,
		): Promise<LogRangeResult>
		followUrl(streamId: string, query?: URLSearchParams | string): string
	}
}

type RuntimeTransportLinks = {
	apiBase: string
	rpc: string
	graphql: string
	sse: string
	mcp: string
	signaldbCollection(pluginName: string, collection: string): string
	logsFollow(streamId: string, query?: URLSearchParams | string): string
	extensionEvents(namespaces?: string[]): string
}

export interface RuntimeTransportClient {
	fetch: RuntimeFetch
	http: RuntimeTransportHttp
	links: RuntimeTransportLinks
	extensions: ExtensionUiRpcMap
	withRpc: <T>(runner: (client: RpcStub<RuntimeRpcApi>) => Promise<T>) => Promise<T>
	createSse: (options?: SseClientOptions) => SseClientWithNamespaces
	sse: SseClientWithNamespaces
	dispose: () => void
}

function createRuntimeTreatyClient(
	links: RuntimeTransportLinks,
	fetch: RuntimeFetch,
): RuntimeTreatyClient {
	// Keep the Treaty surface locally typed.
	// The internal Elysia app is assembled from dynamically mounted runtime plugins,
	// so end-to-end route inference currently collapses before it reaches this client.
	// Re-exporting that unstable server-side type here would couple browser code to
	// internal assembly details without improving the public plugin/UI contract.
	return treaty(links.apiBase, {
		fetcher: toGlobalFetch(fetch),
	}) as unknown as RuntimeTreatyClient
}

function createRuntimeTransportHttp(
	http: RuntimeTreatyClient,
	links: RuntimeTransportLinks,
): RuntimeTransportHttp {
	return {
		meta: {
			info: (init) => expectData<RuntimeMeta>(http.meta.get({ fetch: init })),
			auth: (init) => expectData<RuntimeAuthMeta>(http.meta.auth.get({ fetch: init })),
		},
		extensions: {
			manifest: (init) =>
				expectData<ExtensionManifest>(http.extensions.manifest.get({ fetch: init })),
		},
		logs: {
			streams: (init) =>
				expectData<RuntimeLogStreamsIndex>(http.logs.v1.streams.get({ fetch: init })),
			meta: (streamId, init) =>
				expectData<LogStreamMeta>(http.logs.v1.streams({ streamId }).meta.get({ fetch: init })),
			range: (streamId, query, init) =>
				expectData<LogRangeResult>(
					http.logs.v1.streams({ streamId }).range.get({
						query,
						fetch: init,
					}),
				),
			followUrl: (streamId, query) => links.logsFollow(streamId, query),
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

function resolveApiBase(options: RuntimeTransportClientOptions): string {
	return resolveClientUrl(
		options.apiBase ??
			(typeof options.origin === 'string' && options.origin
				? joinPath(options.origin, HMR_INTERNAL_API_BASE)
				: HMR_INTERNAL_API_BASE),
	)
}

function resolveBaseFetch(options: RuntimeTransportClientOptions): RuntimeFetch {
	const fetchImpl =
		options.fetch ??
		(typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
	if (!fetchImpl) {
		throw new Error('[runtime-web] global fetch is unavailable; pass `options.fetch` explicitly.')
	}
	return fetchImpl
}

function withDefaultCredentials(
	baseFetch: RuntimeFetch,
	credentials: RequestCredentials,
): RuntimeFetch {
	return (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.credentials !== undefined) return baseFetch(input as any, init as any)
		const isRequest = typeof Request === 'function' && input instanceof Request
		if (!init && isRequest) return baseFetch(input as any, init as any)
		return baseFetch(input as any, { ...init, credentials } as any)
	}
}

export function createRuntimeTransportFetch(
	options: RuntimeTransportClientOptions = {},
): RuntimeFetch {
	const credentials: RequestCredentials = options.credentials ?? 'same-origin'
	const baseFetch = withDefaultCredentials(resolveBaseFetch(options), credentials)
	if (options.auth?.enabled === false) return baseFetch
	return createAuthAwareFetch(baseFetch, {
		onBlocked: options.auth?.onBlocked ?? defaultOnAuthBlocked,
		requireMarkerHeader: options.auth?.requireMarkerHeader,
	})
}

export function createRuntimeTransportLinks(
	options: RuntimeTransportClientOptions = {},
): RuntimeTransportLinks {
	const apiBase = resolveApiBase(options)
	const transport = {
		apiBase,
		rpc: resolveClientUrl(options.rpcBase ?? joinPath(apiBase, HMR_TRANSPORT_PATHS.rpc)),
		graphql: resolveClientUrl(joinPath(apiBase, HMR_TRANSPORT_PATHS.graphql)),
		sse: resolveClientUrl(joinPath(apiBase, HMR_TRANSPORT_PATHS.sse)),
		mcp: resolveClientUrl(joinPath(apiBase, HMR_TRANSPORT_PATHS.mcp)),
		signaldbCollection: (pluginName: string, collection: string) =>
			resolveClientUrl(joinPath(apiBase, hmrSignalDbCollectionPath(pluginName, collection))),
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

export function createRuntimeTransportClient(
	options: RuntimeTransportClientOptions = {},
): RuntimeTransportClient {
	const fetch = createRuntimeTransportFetch(options)
	const links = createRuntimeTransportLinks(options)
	const httpClient = createRuntimeTreatyClient(links, fetch)
	const http = createRuntimeTransportHttp(httpClient, links)
	const baseSseOptions = options.sse ?? {}
	const defaultNamespaces = options.defaultNamespace ? [options.defaultNamespace] : undefined
	const credentials: RequestCredentials = options.credentials ?? 'same-origin'
	const authEnabled = options.auth?.enabled !== false
	const rawRpc = createRpcClientFactory(links.rpc)
	const extensions = createUiRpcView(rawRpc, { credentials })
	const withRpc = <T>(runner: (client: RpcStub<RuntimeRpcApi>) => Promise<T>) =>
		invokeRpc(runner, { rpcBase: links.rpc, credentials })

	const baseNamespaces = mergeNamespaces(baseSseOptions.namespaces, defaultNamespaces)

	const buildSseOptions = (opts?: SseClientOptions, inheritNamespaces = true): SseClientOptions => {
		const params = { ...baseSseOptions.params, ...opts?.params }
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
			url: opts?.url ?? baseSseOptions.url ?? links.sse,
			withCredentials,
			auth: authEnabled
				? {
						metaUrl: joinPath(links.apiBase, HMR_META_AUTH_PATH),
						fetch,
						onBlocked: options.auth?.onBlocked ?? defaultOnAuthBlocked,
					}
				: undefined,
			params,
			namespaces: namespaces.length > 0 ? namespaces : undefined,
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
		http,
		links,
		extensions,
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
