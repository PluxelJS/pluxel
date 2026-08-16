import type { RpcStub } from 'capnweb'
import { treaty } from '@elysiajs/eden'

import {
	type AdminAccessAwareFetchOptions,
	createAdminAccessAwareFetch,
	defaultOnAdminAccessBlocked,
	type RuntimeFetch,
	toGlobalFetch,
} from './admin-access'
import type { LogFilter, LogRangeResult, LogStreamMeta } from './logs'
import type { WorkbenchCatalog, WorkbenchLayout } from '../workbench/contracts'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'
import type { HostApplicationMeta } from '../product-contract'
import type { RuntimeRpcApi } from './protocol'
import { createWorkbenchRpcView, createRpcClientFactory, invokeRpc } from './rpc'
import { type SseClientOptions, type SseClientWithNamespaces, sseWithLifecycle } from './sse'
import { createRuntimeSecurityClient } from './security'
import { runRuntimeTransportCleanups } from './client-lifecycle'
import {
	RUNTIME_WORKBENCH_EVENTS_PATH,
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_TRANSPORT_PATHS,
	runtimeWorkbenchModelEventsPath,
	runtimeWorkbenchLiveQueryPath,
	runtimeLogStreamPath,
	joinPath,
} from './paths'
import { mergeNamespaces } from './utils'
import { resolveClientUrl } from './http-utils'

export interface RuntimeMeta {
	service: 'pluxel-runtime'
	ready: true
	application: HostApplicationMeta
	sse: {
		namespaces: string[]
	}
	workbench: {
		version: number
		bundles: number
	}
	transport: {
		rpc: string
		graphql: string
		sse: string
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
	workbench: {
		catalog: RuntimeTreatyGet<WorkbenchCatalog>
		layout: {
			global: RuntimeTreatyGet<WorkbenchLayout>
			plugin: (params: { target: string }) => RuntimeTreatyGet<WorkbenchLayout>
		}
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
	adminAccess?: AdminAccessAwareFetchOptions & {
		enabled?: boolean
	}
}

type RuntimeTransportHttp = {
	meta: {
		info(init?: RequestInit): Promise<RuntimeMeta>
	}
	workbench: {
		catalog(init?: RequestInit): Promise<WorkbenchCatalog>
		globalLayout(init?: RequestInit): Promise<WorkbenchLayout>
		pluginLayout(target: PluginNodeAddressSnapshot, init?: RequestInit): Promise<WorkbenchLayout>
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
	workbenchLiveQuery(grantId: string, params?: unknown): string
	workbenchModelEvents(grantId: string): string
	logsFollow(streamId: string, query?: URLSearchParams | string): string
	workbenchEvents(): string
}

export interface RuntimeTransportClient {
	fetch: RuntimeFetch
	http: RuntimeTransportHttp
	links: RuntimeTransportLinks
	workbench: {
		rpc<TRpc>(grantId: string): TRpc
		events<TEvent = unknown>(
			grantId: string,
		): SseClientWithNamespaces & { readonly __event?: TEvent }
	}
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
		workbench: {
			catalog: (init) => expectData<WorkbenchCatalog>(http.workbench.catalog.get({ fetch: init })),
			globalLayout: (init) =>
				expectData<WorkbenchLayout>(http.workbench.layout.global.get({ fetch: init })),
			pluginLayout: (target, init) =>
				expectData<WorkbenchLayout>(
					http.workbench.layout.plugin({ target: JSON.stringify(target) }).get({ fetch: init }),
				),
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
	if (options.adminAccess?.enabled === false) return baseFetch
	return createAdminAccessAwareFetch(baseFetch, {
		onBlocked: options.adminAccess?.onBlocked ?? defaultOnAdminAccessBlocked,
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
		workbenchLiveQuery: (grantId: string, params?: unknown) => {
			const url = resolveClientUrl(joinPath(apiBase, runtimeWorkbenchLiveQueryPath(grantId)))
			if (params === undefined) return url
			const query = new URLSearchParams({ params: JSON.stringify(params) })
			return `${url}?${query}`
		},
		workbenchModelEvents: (grantId: string) =>
			resolveClientUrl(joinPath(apiBase, runtimeWorkbenchModelEventsPath(grantId))),
		logsFollow: (streamId: string, query?: URLSearchParams | string) => {
			const base = resolveClientUrl(joinPath(apiBase, runtimeLogStreamPath(streamId, '/follow')))
			const suffix =
				query instanceof URLSearchParams ? query.toString() : typeof query === 'string' ? query : ''
			return suffix ? `${base}?${suffix}` : base
		},
		workbenchEvents: () => resolveClientUrl(joinPath(apiBase, RUNTIME_WORKBENCH_EVENTS_PATH)),
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
	const adminAccessEnabled = options.adminAccess?.enabled !== false
	const security = createRuntimeSecurityClient({
		apiBase: links.apiBase,
		fetch,
	})
	const rawRpc = createRpcClientFactory(links.rpc)
	const workbenchRpcs = createWorkbenchRpcView(rawRpc, { credentials })
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
			adminAccess: adminAccessEnabled
				? {
						readState: async () => {
							const overview = await security.readOverview()
							return overview.adminAccess
						},
						onBlocked: options.adminAccess?.onBlocked ?? defaultOnAdminAccessBlocked,
					}
				: undefined,
			params,
			namespaces: namespaces.length > 0 ? namespaces : undefined,
		}
	}

	const managedSse = new Set<SseClientWithNamespaces>()
	const createSse = (opts?: SseClientOptions) => {
		let client: SseClientWithNamespaces
		client = sseWithLifecycle(buildSseOptions(opts), () => managedSse.delete(client))
		managedSse.add(client)
		return client
	}

	let memoSse: SseClientWithNamespaces | null = null
	const getSse = () => {
		if (!memoSse) memoSse = createSse()
		return memoSse
	}

	const client: RuntimeTransportClient = {
		fetch,
		http,
		links,
		workbench: {
			rpc: <TRpc>(grantId: string) => (workbenchRpcs as Record<string, unknown>)[grantId] as TRpc,
			events: <TEvent = unknown>(grantId: string) =>
				createSse({ url: links.workbenchModelEvents(grantId) }) as SseClientWithNamespaces & {
					readonly __event?: TEvent
				},
		},
		withRpc,
		createSse,
		get sse() {
			return getSse()
		},
		dispose: () => {
			runRuntimeTransportCleanups(client)
			for (const stream of managedSse) stream.close()
			managedSse.clear()
			memoSse = null
		},
	}
	return client
}
