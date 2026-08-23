import type { PluginNodeAddress } from '@pluxel/core'
import { treaty } from '@elysiajs/eden'
import type { RpcStub } from 'capnweb'
import type { WorkbenchCatalog, WorkbenchLayout } from '../workbench/contracts'
import { defaultOnAdminAccessBlocked, toGlobalFetch, type RuntimeFetch } from './admin-access'
import { resolveRuntimeClientConnection, type RuntimeClientConnectionOptions } from './connection'
import { expectData, type RuntimeTreatyGet } from './eden'
import { resolveClientUrl } from './http-utils'
import type { RuntimeRpcApi } from './internal-protocol'
import {
	joinPath,
	RUNTIME_TRANSPORT_PATHS,
	RUNTIME_WORKBENCH_EVENTS_PATH,
	runtimeWorkbenchLiveQueryPath,
	runtimeWorkbenchModelEventsPath,
} from './paths'
import { createRpcClientFactory, createWorkbenchRpcView, invokeRpc } from './rpc'
import { createRuntimeSecurityClient } from './security'
import { sseWithLifecycle, type SseClientOptions, type SseClientWithNamespaces } from './sse'
import { mergeNamespaces } from './utils'

export type RuntimeTransportClientOptions = RuntimeClientConnectionOptions &
	Readonly<{
		sse?: SseClientOptions
		defaultNamespace?: string
	}>

export type RuntimeTransportWorkbenchClient = Readonly<{
	catalog(init?: RequestInit): Promise<WorkbenchCatalog>
	globalLayout(init?: RequestInit): Promise<WorkbenchLayout>
	pluginLayout(target: PluginNodeAddress, init?: RequestInit): Promise<WorkbenchLayout>
	rpc<TRpc>(grantId: string): TRpc
	events<TEvent = unknown>(grantId: string): SseClientWithNamespaces & { readonly __event?: TEvent }
	liveQueryUrl(grantId: string, params?: unknown): string
	modelEventsUrl(grantId: string): string
	layoutEventsUrl(): string
}>

export type RuntimeTransportClient = Readonly<{
	fetch: RuntimeFetch
	workbench: RuntimeTransportWorkbenchClient
	withRpc<T>(runner: (client: RpcStub<RuntimeRpcApi>) => Promise<T>): Promise<T>
	createSse(options?: SseClientOptions): SseClientWithNamespaces
	readonly sse: SseClientWithNamespaces
	dispose(): void
}>

interface RuntimeWorkbenchTreatyClient {
	workbench: {
		catalog: RuntimeTreatyGet<WorkbenchCatalog>
		layout: {
			global: RuntimeTreatyGet<WorkbenchLayout>
			plugin: RuntimeTreatyGet<WorkbenchLayout, { target: string }>
		}
	}
}

function createRuntimeWorkbenchTreatyClient(
	apiBase: string,
	fetch: RuntimeFetch,
): RuntimeWorkbenchTreatyClient {
	return treaty(apiBase, {
		fetcher: toGlobalFetch(fetch),
	}) as unknown as RuntimeWorkbenchTreatyClient
}

export function createRuntimeTransportClient(
	options: RuntimeTransportClientOptions = {},
): RuntimeTransportClient {
	let disposed = false
	const assertActive = (): void => {
		if (disposed) throw new Error('[runtime-web] transport client is disposed')
	}

	const connection = resolveRuntimeClientConnection(options)
	const { apiBase, rpcBase, credentials, fetch } = connection
	const sseUrl = resolveClientUrl(joinPath(apiBase, RUNTIME_TRANSPORT_PATHS.sse))
	const treatyClient = createRuntimeWorkbenchTreatyClient(apiBase, fetch)
	const baseSseOptions = options.sse ?? {}
	const defaultNamespaces = options.defaultNamespace ? [options.defaultNamespace] : undefined
	const adminAccessEnabled = options.adminAccess !== false
	const onAdminAccessBlocked =
		options.adminAccess === false
			? defaultOnAdminAccessBlocked
			: (options.adminAccess?.onBlocked ?? defaultOnAdminAccessBlocked)
	const security = createRuntimeSecurityClient({ apiBase, fetch })
	const rawRpc = createRpcClientFactory(rpcBase)
	const workbenchRpcs = createWorkbenchRpcView(rawRpc, { credentials, assertActive })
	const withRpc = <T>(runner: (client: RpcStub<RuntimeRpcApi>) => Promise<T>) => {
		assertActive()
		return invokeRpc(runner, { rpcBase, credentials })
	}

	const baseNamespaces = mergeNamespaces(baseSseOptions.namespaces, defaultNamespaces)
	const buildSseOptions = (opts?: SseClientOptions): SseClientOptions => {
		const params = { ...baseSseOptions.params, ...opts?.params }
		const namespaces = mergeNamespaces(baseNamespaces, opts?.namespaces)
		const withCredentials =
			opts?.withCredentials ??
			baseSseOptions.withCredentials ??
			(credentials === 'include' ? true : undefined)

		return {
			...baseSseOptions,
			...opts,
			url: opts?.url ?? baseSseOptions.url ?? sseUrl,
			withCredentials,
			adminAccess: adminAccessEnabled
				? {
						readState: async () => {
							const overview = await security.readOverview()
							return overview.adminAccess
						},
						onBlocked: onAdminAccessBlocked,
					}
				: undefined,
			params,
			namespaces: namespaces.length > 0 ? namespaces : undefined,
		}
	}

	const managedSse = new Set<SseClientWithNamespaces>()
	const createSse = (opts?: SseClientOptions) => {
		assertActive()
		let client: SseClientWithNamespaces
		client = sseWithLifecycle(buildSseOptions(opts), () => managedSse.delete(client))
		managedSse.add(client)
		return client
	}

	let memoSse: SseClientWithNamespaces | null = null
	const getSse = () => {
		assertActive()
		if (!memoSse) memoSse = createSse()
		return memoSse
	}

	const workbench: RuntimeTransportWorkbenchClient = Object.freeze({
		catalog: (init) =>
			expectData<WorkbenchCatalog>(treatyClient.workbench.catalog.get({ fetch: init })),
		globalLayout: (init) =>
			expectData<WorkbenchLayout>(treatyClient.workbench.layout.global.get({ fetch: init })),
		pluginLayout: (target, init) =>
			expectData<WorkbenchLayout>(
				treatyClient.workbench.layout.plugin.get({
					query: { target: JSON.stringify(target) },
					fetch: init,
				}),
			),
		rpc: <TRpc>(grantId: string) => (workbenchRpcs as Record<string, unknown>)[grantId] as TRpc,
		events: <TEvent = unknown>(grantId: string) =>
			createSse({
				url: resolveClientUrl(joinPath(apiBase, runtimeWorkbenchModelEventsPath(grantId))),
			}) as SseClientWithNamespaces & { readonly __event?: TEvent },
		liveQueryUrl: (grantId, params) => {
			const url = resolveClientUrl(joinPath(apiBase, runtimeWorkbenchLiveQueryPath(grantId)))
			if (params === undefined) return url
			return `${url}?${new URLSearchParams({ params: JSON.stringify(params) })}`
		},
		modelEventsUrl: (grantId) =>
			resolveClientUrl(joinPath(apiBase, runtimeWorkbenchModelEventsPath(grantId))),
		layoutEventsUrl: () => resolveClientUrl(joinPath(apiBase, RUNTIME_WORKBENCH_EVENTS_PATH)),
	})

	const client: RuntimeTransportClient = Object.freeze({
		fetch,
		workbench,
		withRpc,
		createSse,
		get sse() {
			return getSse()
		},
		dispose: () => {
			if (disposed) return
			disposed = true
			for (const stream of managedSse) stream.close()
			managedSse.clear()
			memoSse = null
		},
	})
	return client
}
