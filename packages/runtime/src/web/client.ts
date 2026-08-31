import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { RpcStub } from '../capnweb'
import type {
	ConfigFieldMutation,
	ConfigPresentationResult,
	ConfigResult,
	EnsureForkResult,
	LoggingHandleApi,
	PluginAutoStartBatchItem,
	PluginConsumerRequirementsInspectionResult,
	PluginControlBatchResult,
	PluginDependencyGraphSnapshot,
	PluginDependencyMutationResult,
	PluginCatalogLayoutInput,
	PluginCatalogLayoutMutationResult,
	PluginCatalogSnapshot,
	PluginLifecycleCommandBatchItem,
	PluginProviderPolicyInspectionResult,
	PluginStatusQueryResult,
	RemoveForkResult,
	RuntimeMeta,
} from './protocol'
import type {
	RuntimeLogFollowInput,
	RuntimeLogRangeQuery,
	RuntimeLogStreamsIndex,
	RuntimeManagementTarget,
} from './management-target'
import type { LogRangeResult, LogStreamMeta, RuntimeLogEvent } from './logs'
import type { RuntimeSecurityClient } from './security'
import {
	parseConfigPresentationResult,
	parseConfigResult,
	parseEnsureForkResult,
	parseLogRangeResult,
	parseLogStreamMeta,
	parsePluginConsumerRequirementsInspectionResult,
	parsePluginControlBatchResult,
	parsePluginDependencyGraphSnapshot,
	parsePluginDependencyMutationResult,
	parsePluginCatalogLayoutMutationResult,
	parsePluginCatalogSnapshot,
	parsePluginLogPolicyMutationResult,
	parsePluginProviderPolicyInspectionResult,
	parsePluginStatusQueryResult,
	parseRemoveForkResult,
	parseRuntimeLogEvent,
	parseRuntimeLogStreamsIndex,
	parseSecurityAuditEvents,
	parseSecurityOverview,
	parseVaultAdminState,
	parseVaultKeyPair,
	parseVaultPublicKeyResult,
	parseVersionedPluginLogPolicySnapshot,
} from './management-validation'
import { parseRuntimeMeta } from './validation'

export type { RuntimeLogFollowInput, RuntimeLogRangeQuery, RuntimeLogStreamsIndex }

export type RuntimeLogClient = Readonly<{
	streams(): Promise<RuntimeLogStreamsIndex>
	meta(streamId: string): Promise<LogStreamMeta>
	range(streamId: string, query: RuntimeLogRangeQuery): Promise<LogRangeResult>
	follow(
		input: RuntimeLogFollowInput,
		observer: (event: RuntimeLogEvent) => void | Promise<void>,
	): Promise<Disposable>
}>

/** Framework-neutral facade over one borrowed Management capability from the page session. */
export type RuntimeManagementClient = Readonly<{
	describe(): Promise<RuntimeMeta>
	catalog: Readonly<{
		snapshot(): Promise<PluginCatalogSnapshot>
		updateLayout(input: PluginCatalogLayoutInput): Promise<PluginCatalogLayoutMutationResult>
	}>
	plugins: Readonly<{
		status(owner: PluginNodeAddress): Promise<PluginStatusQueryResult>
		setAutoStart(items: readonly PluginAutoStartBatchItem[]): Promise<PluginControlBatchResult>
		applyLifecycleCommands(
			items: readonly PluginLifecycleCommandBatchItem[],
		): Promise<PluginControlBatchResult>
	}>
	config: Readonly<{
		presentation(owner: PluginNodeAddress): Promise<ConfigPresentationResult>
		get(owner: PluginNodeAddress): Promise<ConfigResult>
		patch(owner: PluginNodeAddress, patch: Record<string, unknown>): Promise<ConfigResult>
		patchField(owner: PluginNodeAddress, input: ConfigFieldMutation): Promise<ConfigResult>
	}>
	dependencies: Readonly<{
		graph(): Promise<PluginDependencyGraphSnapshot>
		inspectConsumerRequirements(
			consumer: PluginNodeAddress,
		): Promise<PluginConsumerRequirementsInspectionResult>
		setConsumerOverride(input: {
			consumer: PluginNodeAddress
			requirement: PluginDefinitionAddress
			provider: PluginNodeAddress | null
		}): Promise<PluginDependencyMutationResult>
		inspectProviderPolicy(
			policyOwner: PluginNodeAddress,
		): Promise<PluginProviderPolicyInspectionResult>
		setProviderPolicyDefault(input: {
			policyOwner: PluginNodeAddress
			provider: PluginNodeAddress | null
		}): Promise<PluginDependencyMutationResult>
	}>
	forks: Readonly<{
		ensure(input: {
			base: PluginNodeAddress
			forkId: string
			autoStart?: boolean
			selectFor?: {
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}
		}): Promise<EnsureForkResult>
		remove(input: { base: PluginNodeAddress; forkId: string }): Promise<RemoveForkResult>
	}>
	logging: Readonly<LoggingHandleApi>
	logs: RuntimeLogClient
	security: RuntimeSecurityClient
}>

export function createRuntimeManagementClient(
	management: RpcStub<RuntimeManagementTarget>,
): RuntimeManagementClient {
	assertManagementTarget(management)
	const call = <T>(
		run: (target: RpcStub<RuntimeManagementTarget>) => PromiseLike<unknown> | unknown,
		parse: (input: unknown) => T,
	): Promise<T> => readPortableResult(run(management), parse)

	const client: RuntimeManagementClient = {
		describe: () => call((root) => root.describe(), parseRuntimeMeta),
		catalog: Object.freeze({
			snapshot: () => call((root) => root.pluginCatalog(), parsePluginCatalogSnapshot),
			updateLayout: (input) =>
				call(
					(root) =>
						root.updatePluginCatalogLayout({
							sections: input.sections.map((section) => ({
								sectionId: section.sectionId,
								nodes: [...section.nodes],
							})),
						}),
					parsePluginCatalogLayoutMutationResult,
				),
		}),
		plugins: Object.freeze({
			status: (owner) => call((root) => root.pluginStatus(owner), parsePluginStatusQueryResult),
			setAutoStart: (items) =>
				call((root) => root.setPluginAutoStart([...items]), parsePluginControlBatchResult),
			applyLifecycleCommands: (items) =>
				call(
					(root) => root.applyPluginLifecycleCommands([...items]),
					parsePluginControlBatchResult,
				),
		}),
		config: Object.freeze({
			presentation: (owner) =>
				call((root) => root.pluginConfigPresentation(owner), parseConfigPresentationResult),
			get: (owner) => call((root) => root.pluginConfig(owner), parseConfigResult),
			patch: (owner, patch) =>
				call((root) => root.patchPluginConfig(owner, patch), parseConfigResult),
			patchField: (owner, input) =>
				call((root) => root.patchPluginConfigField(owner, input), parseConfigResult),
		}),
		dependencies: Object.freeze({
			graph: () => call((root) => root.pluginDependencyGraph(), parsePluginDependencyGraphSnapshot),
			inspectConsumerRequirements: (consumer) =>
				call(
					(root) => root.inspectPluginConsumerRequirements(consumer),
					parsePluginConsumerRequirementsInspectionResult,
				),
			setConsumerOverride: (input) =>
				call((root) => root.setPluginConsumerOverride(input), parsePluginDependencyMutationResult),
			inspectProviderPolicy: (policyOwner) =>
				call(
					(root) => root.inspectPluginProviderPolicy(policyOwner),
					parsePluginProviderPolicyInspectionResult,
				),
			setProviderPolicyDefault: (input) =>
				call(
					(root) => root.setPluginProviderPolicyDefault(input),
					parsePluginDependencyMutationResult,
				),
		}),
		forks: Object.freeze({
			ensure: (input) => call((root) => root.ensurePluginFork(input), parseEnsureForkResult),
			remove: (input) => call((root) => root.removePluginFork(input), parseRemoveForkResult),
		}),
		logging: Object.freeze({
			getPolicy: () => call((root) => root.getLogPolicy(), parseVersionedPluginLogPolicySnapshot),
			replacePolicy: (expectedRevision, snapshot) =>
				call(
					(root) => root.replaceLogPolicy(expectedRevision, snapshot),
					parsePluginLogPolicyMutationResult,
				),
			setDefaultLevel: (expectedRevision, level) =>
				call(
					(root) => root.setDefaultLogLevel(expectedRevision, level),
					parsePluginLogPolicyMutationResult,
				),
			setPluginLevel: (expectedRevision, owner, level) =>
				call(
					(root) => root.setPluginLogLevel(expectedRevision, owner, level),
					parsePluginLogPolicyMutationResult,
				),
			clearPluginLevel: (expectedRevision, owner) =>
				call(
					(root) => root.clearPluginLogLevel(expectedRevision, owner),
					parsePluginLogPolicyMutationResult,
				),
			resetPolicy: (expectedRevision) =>
				call(
					(root) => root.resetLogPolicy(expectedRevision),
					parseVersionedPluginLogPolicySnapshot,
				),
		}),
		logs: Object.freeze({
			streams: () => call((root) => root.logStreams(), parseRuntimeLogStreamsIndex),
			meta: (streamId) => call((root) => root.logMeta(streamId), parseLogStreamMeta),
			range: (streamId, query) =>
				call((root) => root.logRange(streamId, query), parseLogRangeResult),
			follow: async (input, observer) => {
				if (typeof observer !== 'function') throw new TypeError('Log observer must be a function')
				const subscription = await management.followLogs(input, async (event) => {
					await observer(parseRuntimeLogEvent(event))
				})
				if (!subscription || typeof subscription[Symbol.dispose] !== 'function') {
					throw new TypeError('Log follow did not return a disposable subscription')
				}
				return subscription
			},
		}),
		security: Object.freeze({
			readOverview: () => call((root) => root.securityOverview(), parseSecurityOverview),
			listEvents: (limit) => call((root) => root.securityEvents(limit), parseSecurityAuditEvents),
			vault: Object.freeze({
				unlock: () => call((root) => root.vaultUnlock(), parseVaultAdminState),
				ensureHostKey: () => call((root) => root.vaultEnsureHostKey(), parseVaultPublicKeyResult),
				generateDeployKey: () => call((root) => root.vaultGenerateDeployKey(), parseVaultKeyPair),
				setDeployRecipients: (publicKeys: readonly string[]) =>
					call((root) => root.vaultSetDeployRecipients([...publicKeys]), parseVaultAdminState),
			}),
		}),
	}
	return Object.freeze(client)
}

async function readPortableResult<T>(
	resultPromise: PromiseLike<unknown> | unknown,
	parse: (input: unknown) => T,
): Promise<T> {
	const result = await resultPromise
	const dispose =
		result && (typeof result === 'object' || typeof result === 'function')
			? (result as { [Symbol.dispose]?: () => void })[Symbol.dispose]
			: undefined
	try {
		const portable =
			typeof dispose === 'function'
				? Array.isArray(result)
					? [...result]
					: Object.fromEntries(Object.entries(result as object))
				: result
		return parse(portable)
	} finally {
		dispose?.call(result)
	}
}

function assertManagementTarget(
	value: RpcStub<RuntimeManagementTarget>,
): asserts value is RpcStub<RuntimeManagementTarget> {
	if ((!value || typeof value !== 'object') && typeof value !== 'function') {
		throw new TypeError("Management target must be a Cap'n Web stub")
	}
}
