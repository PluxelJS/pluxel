import type { RpcStub } from 'capnweb'
import { treaty } from '@elysiajs/eden'

import {
	type VerificationAwareFetchOptions,
	createVerificationAwareFetch,
	defaultOnVerificationBlocked,
	type RuntimeFetch,
	toGlobalFetch,
} from './verification'
import type { LogFilter, LogRangeResult, LogStreamMeta } from './logs'
import type { ExtensionManifest } from './extensions'
import type { ExtensionUiRpcMap, RuntimeRpcApi } from './protocol'
import { createRpcClientFactory, createUiRpcView, invokeRpc } from './rpc'
import { type SseClientOptions, type SseClientWithNamespaces, sse } from './sse'
import { createRuntimeSecurityClient } from './security'
import {
	RUNTIME_EXTENSIONS_EVENTS_PATH,
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_TRANSPORT_PATHS,
	runtimeSignalDbCollectionPath,
	runtimeLogStreamPath,
	joinPath,
} from './paths'
import { mergeNamespaces } from './utils'
import { resolveClientUrl } from './http-utils'

export interface RuntimeMeta {
	service: 'pluxel-runtime'
	ready: true
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
	meta: RuntimeTreatyGet<RuntimeMeta>
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
	verification?: VerificationAwareFetchOptions & {
		enabled?: boolean
	}
}

type RuntimeTransportHttp = {
	meta: {
		info(init?: RequestInit): Promise<RuntimeMeta>
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

function resolveApiBase(options: RuntimeTransportClientOptions): string {
	return resolveClientUrl(
		options.apiBase ??
			(typeof options.origin === 'string' && options.origin
				? joinPath(options.origin, RUNTIME_INTERNAL_API_BASE)
				: RUNTIME_INTERNAL_API_BASE),
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
	if (options.verification?.enabled === false) return baseFetch
	return createVerificationAwareFetch(baseFetch, {
		onBlocked: options.verification?.onBlocked ?? defaultOnVerificationBlocked,
	})
}

export function createRuntimeTransportLinks(
	options: RuntimeTransportClientOptions = {},
): RuntimeTransportLinks {
	const apiBase = resolveApiBase(options)
	const transport = {
		apiBase,
		rpc: resolveClientUrl(options.rpcBase ?? joinPath(apiBase, RUNTIME_TRANSPORT_PATHS.rpc)),
		graphql: resolveClientUrl(joinPath(apiBase, RUNTIME_TRANSPORT_PATHS.graphql)),
		sse: resolveClientUrl(joinPath(apiBase, RUNTIME_TRANSPORT_PATHS.sse)),
		signaldbCollection: (pluginName: string, collection: string) =>
			resolveClientUrl(joinPath(apiBase, runtimeSignalDbCollectionPath(pluginName, collection))),
		logsFollow: (streamId: string, query?: URLSearchParams | string) => {
			const base = resolveClientUrl(joinPath(apiBase, runtimeLogStreamPath(streamId, '/follow')))
			const suffix =
				query instanceof URLSearchParams ? query.toString() : typeof query === 'string' ? query : ''
			return suffix ? `${base}?${suffix}` : base
		},
		extensionEvents: (namespaces?: string[]) => {
			const base = resolveClientUrl(joinPath(apiBase, RUNTIME_EXTENSIONS_EVENTS_PATH))
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
	const verificationEnabled = options.verification?.enabled !== false
	const security = createRuntimeSecurityClient({
		apiBase: links.apiBase,
		fetch,
	})
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
			verification: verificationEnabled
				? {
						readState: async () => {
							const overview = await security.readOverview()
							return overview.verification
						},
						onBlocked: options.verification?.onBlocked ?? defaultOnVerificationBlocked,
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
