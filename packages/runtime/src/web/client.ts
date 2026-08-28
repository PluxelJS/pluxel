import { treaty } from '@elysiajs/eden'

import { toGlobalFetch, type RuntimeFetch } from './admin-access'
import type { LogFilter, LogRangeResult, LogStreamMeta } from './logs'
import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type {
	AgentToolsHandleApi,
	BaseProviderInspectionResult,
	ConfigFieldMutation,
	ConfigPresentationResult,
	ConfigResult,
	EnsureForkResult,
	LoggingHandleApi,
	PluginDependencyInspectionResult,
	PluginDependencyListResult,
	PluginDependencyMutationResult,
	PluginGroup,
	PluginGroupInput,
	PluginGroupsMutationResult,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusQueryResult,
	PluginsListOutput,
	RemoveForkResult,
	RuntimeMetaV1,
} from './protocol'
import type { RuntimeManagementRpcApi } from './management-rpc-protocol'
import { parseRuntimeMetaV1 } from './validation'
import {
	parseAgentToolsAdminSnapshot,
	parseBaseProviderInspectionResult,
	parseConfigPresentationResult,
	parseConfigResult,
	parseEnsureForkResult,
	parseLogRangeResult,
	parseLogStreamMeta,
	parsePluginDependencyInspectionResult,
	parsePluginDependencyListResult,
	parsePluginDependencyMutationResult,
	parsePluginGroups,
	parsePluginGroupsMutationResult,
	parsePluginLogPolicyMutationResult,
	parsePluginsListOutput,
	parsePluginStatusBatchResult,
	parsePluginStatusQueryResult,
	parseRemoveForkResult,
	parseRuntimeLogStreamsIndex,
	parseVersionedPluginLogPolicySnapshot,
} from './management-validation'
import { invokeRpc } from './rpc-session'
import { createRuntimeSecurityClient, type RuntimeSecurityClient } from './security'
import { runtimeLogStreamPath, joinPath } from './paths'
import { resolveClientUrl } from './http-utils'
import { resolveRuntimeClientConnection, type RuntimeClientConnectionOptions } from './connection'
import { expectData, type RuntimeTreatyGet } from './eden'

export interface RuntimeLogStreamsIndex {
	readonly streams: readonly LogStreamMeta[]
}

export type RuntimeLogRangeQuery = LogFilter & {
	epoch?: number
	from?: string
	limit?: number
}

type RuntimeTreatyStreamRoute = {
	meta: RuntimeTreatyGet<LogStreamMeta>
	range: RuntimeTreatyGet<LogRangeResult, RuntimeLogRangeQuery>
}

type RuntimeTreatyStreamsRoute = RuntimeTreatyGet<RuntimeLogStreamsIndex> &
	((params: { streamId: string }) => RuntimeTreatyStreamRoute)

interface RuntimeManagementTreatyClient {
	meta: RuntimeTreatyGet<RuntimeMetaV1>
	logs: {
		v1: {
			streams: RuntimeTreatyStreamsRoute
		}
	}
}

export type RuntimeManagementClientOptions = RuntimeClientConnectionOptions

type RuntimeManagementHttp = Readonly<{
	meta: {
		info(init?: RequestInit): Promise<RuntimeMetaV1>
	}
	logs: Readonly<{
		streams(init?: RequestInit): Promise<RuntimeLogStreamsIndex>
		meta(streamId: string, init?: RequestInit): Promise<LogStreamMeta>
		range(
			streamId: string,
			query?: RuntimeLogRangeQuery,
			init?: RequestInit,
		): Promise<LogRangeResult>
		followUrl(streamId: string, query?: URLSearchParams | string): string
	}>
}>

/** Framework-neutral Level 1 management client. No root RPC stub is exposed. */
export type RuntimeManagementClient = Readonly<{
	discover(init?: RequestInit): Promise<RuntimeMetaV1>
	plugins: Readonly<{
		list(): Promise<PluginsListOutput>
		status(owner: PluginNodeAddress): Promise<PluginStatusQueryResult>
		applyStatusActions(
			actions: readonly PluginStatusBatchAction[],
		): Promise<PluginStatusBatchResult>
	}>
	config: Readonly<{
		presentation(owner: PluginNodeAddress): Promise<ConfigPresentationResult>
		get(owner: PluginNodeAddress): Promise<ConfigResult>
		patch(owner: PluginNodeAddress, patch: Record<string, unknown>): Promise<ConfigResult>
		patchField(owner: PluginNodeAddress, input: ConfigFieldMutation): Promise<ConfigResult>
	}>
	dependencies: Readonly<{
		list(owner: PluginNodeAddress): Promise<PluginDependencyListResult>
		inspect(owner: PluginNodeAddress): Promise<PluginDependencyInspectionResult>
		setTarget(input: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress | null
		}): Promise<PluginDependencyMutationResult>
		inspectBaseProvider(owner: PluginNodeAddress): Promise<BaseProviderInspectionResult>
		selectBaseProvider(input: {
			consumer: PluginNodeAddress
			token: PluginDefinitionAddress
			provider: PluginNodeAddress | null
		}): Promise<PluginDependencyMutationResult>
	}>
	forks: Readonly<{
		ensure(input: {
			base: PluginNodeAddress
			forkId: string
			enable?: boolean
			selectFor?: {
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}
		}): Promise<EnsureForkResult>
		remove(input: { base: PluginNodeAddress; forkId: string }): Promise<RemoveForkResult>
	}>
	groups: Readonly<{
		list(): Promise<readonly PluginGroup[]>
		update(groups: readonly PluginGroupInput[]): Promise<PluginGroupsMutationResult>
	}>
	logging: Readonly<LoggingHandleApi>
	agentTools: Readonly<AgentToolsHandleApi>
	logs: RuntimeManagementHttp['logs']
	security: RuntimeSecurityClient
}>

function createRuntimeManagementTreatyClient(
	apiBase: string,
	fetch: RuntimeFetch,
): RuntimeManagementTreatyClient {
	// Keep the Treaty surface locally typed.
	// The internal Elysia app is assembled from dynamically mounted runtime plugins,
	// so end-to-end route inference currently collapses before it reaches this client.
	// Re-exporting that unstable server-side type here would couple browser code to
	// internal assembly details without improving the public plugin/UI contract.
	return treaty(apiBase, {
		fetcher: toGlobalFetch(fetch),
	}) as unknown as RuntimeManagementTreatyClient
}

function createRuntimeManagementHttp(
	http: RuntimeManagementTreatyClient,
	apiBase: string,
): RuntimeManagementHttp {
	return Object.freeze({
		meta: Object.freeze({
			info: async (init?: RequestInit) =>
				parseRuntimeMetaV1(await expectData<RuntimeMetaV1>(http.meta.get({ fetch: init }))),
		}),
		logs: Object.freeze({
			streams: async (init?: RequestInit) =>
				parseRuntimeLogStreamsIndex(
					await expectData<RuntimeLogStreamsIndex>(http.logs.v1.streams.get({ fetch: init })),
				),
			meta: async (streamId: string, init?: RequestInit) =>
				parseLogStreamMeta(
					await expectData<LogStreamMeta>(
						http.logs.v1.streams({ streamId }).meta.get({ fetch: init }),
					),
				),
			range: async (streamId: string, query?: RuntimeLogRangeQuery, init?: RequestInit) =>
				parseLogRangeResult(
					await expectData<LogRangeResult>(
						http.logs.v1.streams({ streamId }).range.get({
							query,
							fetch: init,
						}),
					),
				),
			followUrl: (streamId: string, query?: URLSearchParams | string) => {
				const base = resolveClientUrl(joinPath(apiBase, runtimeLogStreamPath(streamId, '/follow')))
				const suffix =
					query instanceof URLSearchParams
						? query.toString()
						: typeof query === 'string'
							? query
							: ''
				return suffix ? `${base}?${suffix}` : base
			},
		}),
	})
}

/** Discover one runtime without constructing a long-lived client or opening streams. */
export async function discoverRuntime(
	options: RuntimeManagementClientOptions = {},
	init?: RequestInit,
): Promise<RuntimeMetaV1> {
	const { apiBase, fetch } = resolveRuntimeClientConnection(options)
	return await createRuntimeManagementHttp(
		createRuntimeManagementTreatyClient(apiBase, fetch),
		apiBase,
	).meta.info(init)
}

export function createRuntimeManagementClient(
	options: RuntimeManagementClientOptions = {},
): RuntimeManagementClient {
	const { apiBase, rpcBase, credentials, fetch } = resolveRuntimeClientConnection(options)
	const managementHttp = createRuntimeManagementHttp(
		createRuntimeManagementTreatyClient(apiBase, fetch),
		apiBase,
	)
	const rpc = async <T>(
		run: (client: RuntimeManagementRpcApi) => PromiseLike<unknown> | unknown,
		parse: (input: unknown) => T,
	): Promise<T> => {
		const result = await invokeRpc<RuntimeManagementRpcApi, unknown>(
			async (raw) => await Promise.resolve(run(raw as unknown as RuntimeManagementRpcApi)),
			{
				rpcBase,
				credentials,
				fetch,
			},
		)
		const dispose =
			result && typeof result === 'object'
				? (result as { [Symbol.dispose]?: () => void })[Symbol.dispose]
				: undefined
		try {
			// Cap'n Web owns the root result lease with Symbol.dispose. Management parsers
			// intentionally accept portable data only, so materialize that root container
			// before validation while preserving its already-plain nested values.
			const portable =
				typeof dispose === 'function'
					? Array.isArray(result)
						? [...result]
						: Object.fromEntries(Object.entries(result))
					: result
			return parse(portable)
		} finally {
			dispose?.call(result)
		}
	}

	const client: RuntimeManagementClient = {
		discover: (init) => managementHttp.meta.info(init),
		plugins: Object.freeze({
			list: () => rpc((root) => root.pluginsList(), parsePluginsListOutput),
			status: (owner) => rpc((root) => root.pluginStatus(owner), parsePluginStatusQueryResult),
			applyStatusActions: (actions) =>
				rpc((root) => root.applyPluginStatusActions([...actions]), parsePluginStatusBatchResult),
		}),
		config: Object.freeze({
			presentation: (owner) =>
				rpc((root) => root.pluginConfigPresentation(owner), parseConfigPresentationResult),
			get: (owner) => rpc((root) => root.pluginConfig(owner), parseConfigResult),
			patch: (owner, patch) =>
				rpc((root) => root.patchPluginConfig(owner, patch), parseConfigResult),
			patchField: (owner, input) =>
				rpc((root) => root.patchPluginConfigField(owner, input), parseConfigResult),
		}),
		dependencies: Object.freeze({
			list: (owner) =>
				rpc((root) => root.pluginDependencies(owner), parsePluginDependencyListResult),
			inspect: (owner) =>
				rpc((root) => root.inspectPluginDependencies(owner), parsePluginDependencyInspectionResult),
			setTarget: (input) =>
				rpc((root) => root.setPluginDependencyTarget(input), parsePluginDependencyMutationResult),
			inspectBaseProvider: (owner) =>
				rpc((root) => root.inspectPluginBaseProvider(owner), parseBaseProviderInspectionResult),
			selectBaseProvider: (input) =>
				rpc((root) => root.selectPluginBaseProvider(input), parsePluginDependencyMutationResult),
		}),
		forks: Object.freeze({
			ensure: (input) => rpc((root) => root.ensurePluginFork(input), parseEnsureForkResult),
			remove: (input) => rpc((root) => root.removePluginFork(input), parseRemoveForkResult),
		}),
		groups: Object.freeze({
			list: () => rpc((root) => root.pluginGroups(), parsePluginGroups),
			update: (groups) =>
				rpc(
					(root) =>
						root.updatePluginGroups(groups.map((group) => ({ ...group, nodes: [...group.nodes] }))),
					parsePluginGroupsMutationResult,
				),
		}),
		logging: Object.freeze({
			getPolicy: () =>
				rpc((root) => root.logging().getPolicy(), parseVersionedPluginLogPolicySnapshot),
			replacePolicy: (expectedRevision, snapshot) =>
				rpc(
					(root) => root.logging().replacePolicy(expectedRevision, snapshot),
					parsePluginLogPolicyMutationResult,
				),
			setDefaultLevel: (expectedRevision, level) =>
				rpc(
					(root) => root.logging().setDefaultLevel(expectedRevision, level),
					parsePluginLogPolicyMutationResult,
				),
			setPluginLevel: (expectedRevision, owner, level) =>
				rpc(
					(root) => root.logging().setPluginLevel(expectedRevision, owner, level),
					parsePluginLogPolicyMutationResult,
				),
			clearPluginLevel: (expectedRevision, owner) =>
				rpc(
					(root) => root.logging().clearPluginLevel(expectedRevision, owner),
					parsePluginLogPolicyMutationResult,
				),
			resetPolicy: (expectedRevision) =>
				rpc(
					(root) => root.logging().resetPolicy(expectedRevision),
					parseVersionedPluginLogPolicySnapshot,
				),
		}),
		agentTools: Object.freeze({
			snapshot: () => rpc((root) => root.agentTools().snapshot(), parseAgentToolsAdminSnapshot),
			replacePolicy: (expectedRevision, policy) =>
				rpc(
					(root) => root.agentTools().replacePolicy(expectedRevision, policy),
					parseAgentToolsAdminSnapshot,
				),
		}),
		logs: Object.freeze({
			streams: (init) => managementHttp.logs.streams(init),
			meta: (streamId, init) => managementHttp.logs.meta(streamId, init),
			range: (streamId, query, init) => managementHttp.logs.range(streamId, query, init),
			followUrl: (streamId, query) => managementHttp.logs.followUrl(streamId, query),
		}),
		security: createRuntimeSecurityClient({
			apiBase,
			fetch,
		}),
	}
	return Object.freeze(client)
}
