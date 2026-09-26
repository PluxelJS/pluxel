import {
	cloneRuntimeUpdateSnapshot,
	type RuntimeUpdateSnapshot,
} from '@pluxel/host/internal/protocol'
import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { RpcStub } from 'capnweb'
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
import type { LogRangeResult, LogStreamMeta, RuntimeLogEvent } from '../../logging/protocol'
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
	updates: Readonly<{
		snapshot(): Promise<RuntimeUpdateSnapshot | null>
		follow(
			observer: (snapshot: RuntimeUpdateSnapshot | null) => void | Promise<void>,
		): Promise<Disposable>
	}>
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
		describe: () => call((root) => root.describeDto(), parseRuntimeMeta),
		updates: Object.freeze({
			snapshot: () => call((root) => root.runtimeUpdateDto(), cloneRuntimeUpdateSnapshot),
			follow: async (observer) => {
				if (typeof observer !== 'function')
					throw new TypeError('Update observer must be a function')
				const subscription = await management.followRuntimeUpdates(async (snapshot) => {
					await observer(cloneRuntimeUpdateSnapshot(snapshot))
				})
				if (!subscription || typeof subscription[Symbol.dispose] !== 'function')
					throw new TypeError('Update follow did not return a disposable subscription')
				return subscription
			},
		}),
		catalog: Object.freeze({
			snapshot: () => call((root) => root.pluginCatalogDto(), parsePluginCatalogSnapshot),
			updateLayout: (input) =>
				call(
					(root) =>
						root.updatePluginCatalogLayoutDto({
							sections:
								input.sections === null
									? null
									: input.sections.map((section) => ({
											sectionId: section.sectionId,
											name: section.name,
											nodes: [...section.nodes],
										})),
						}),
					parsePluginCatalogLayoutMutationResult,
				),
		}),
		plugins: Object.freeze({
			status: (owner) => call((root) => root.pluginStatusDto(owner), parsePluginStatusQueryResult),
			setAutoStart: (items) =>
				call((root) => root.setPluginAutoStartDto([...items]), parsePluginControlBatchResult),
			applyLifecycleCommands: (items) =>
				call(
					(root) => root.applyPluginLifecycleCommandsDto([...items]),
					parsePluginControlBatchResult,
				),
		}),
		config: Object.freeze({
			presentation: (owner) =>
				call((root) => root.pluginConfigPresentationDto(owner), parseConfigPresentationResult),
			get: (owner) => call((root) => root.pluginConfigDto(owner), parseConfigResult),
			patch: (owner, patch) =>
				call((root) => root.patchPluginConfigDto(owner, patch), parseConfigResult),
			patchField: (owner, input) =>
				call((root) => root.patchPluginConfigFieldDto(owner, input), parseConfigResult),
		}),
		dependencies: Object.freeze({
			graph: () =>
				call((root) => root.pluginDependencyGraphDto(), parsePluginDependencyGraphSnapshot),
			inspectConsumerRequirements: (consumer) =>
				call(
					(root) => root.inspectPluginConsumerRequirementsDto(consumer),
					parsePluginConsumerRequirementsInspectionResult,
				),
			setConsumerOverride: (input) =>
				call(
					(root) => root.setPluginConsumerOverrideDto(input),
					parsePluginDependencyMutationResult,
				),
			inspectProviderPolicy: (policyOwner) =>
				call(
					(root) => root.inspectPluginProviderPolicyDto(policyOwner),
					parsePluginProviderPolicyInspectionResult,
				),
			setProviderPolicyDefault: (input) =>
				call(
					(root) => root.setPluginProviderPolicyDefaultDto(input),
					parsePluginDependencyMutationResult,
				),
		}),
		forks: Object.freeze({
			ensure: (input) => call((root) => root.ensurePluginForkDto(input), parseEnsureForkResult),
			remove: (input) => call((root) => root.removePluginForkDto(input), parseRemoveForkResult),
		}),
		logging: Object.freeze({
			getPolicy: () =>
				call((root) => root.getLogPolicyDto(), parseVersionedPluginLogPolicySnapshot),
			replacePolicy: (expectedRevision, snapshot) =>
				call(
					(root) => root.replaceLogPolicyDto(expectedRevision, snapshot),
					parsePluginLogPolicyMutationResult,
				),
			setDefaultLevel: (expectedRevision, level) =>
				call(
					(root) => root.setDefaultLogLevelDto(expectedRevision, level),
					parsePluginLogPolicyMutationResult,
				),
			setPluginLevel: (expectedRevision, owner, level) =>
				call(
					(root) => root.setPluginLogLevelDto(expectedRevision, owner, level),
					parsePluginLogPolicyMutationResult,
				),
			clearPluginLevel: (expectedRevision, owner) =>
				call(
					(root) => root.clearPluginLogLevelDto(expectedRevision, owner),
					parsePluginLogPolicyMutationResult,
				),
			resetPolicy: (expectedRevision) =>
				call(
					(root) => root.resetLogPolicyDto(expectedRevision),
					parseVersionedPluginLogPolicySnapshot,
				),
		}),
		logs: Object.freeze({
			streams: () => call((root) => root.logStreamsDto(), parseRuntimeLogStreamsIndex),
			meta: (streamId) => call((root) => root.logMetaDto(streamId), parseLogStreamMeta),
			range: (streamId, query) =>
				call((root) => root.logRangeDto(streamId, query), parseLogRangeResult),
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
			readOverview: () => call((root) => root.securityOverviewDto(), parseSecurityOverview),
			listEvents: (limit) =>
				call((root) => root.securityEventsDto(limit), parseSecurityAuditEvents),
			vault: Object.freeze({
				unlock: () => call((root) => root.vaultUnlockDto(), parseVaultAdminState),
				ensureHostKey: () =>
					call((root) => root.vaultEnsureHostKeyDto(), parseVaultPublicKeyResult),
				generateDeployKey: () =>
					call((root) => root.vaultGenerateDeployKeyDto(), parseVaultKeyPair),
				setDeployRecipients: (publicKeys: readonly string[]) =>
					call((root) => root.vaultSetDeployRecipientsDto([...publicKeys]), parseVaultAdminState),
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
			? Object.getOwnPropertyDescriptor(result, Symbol.dispose)?.value
			: undefined
	try {
		if (
			typeof dispose === 'function' &&
			!Reflect.deleteProperty(result as object, Symbol.dispose)
		) {
			throw new TypeError('Management result disposer must be configurable')
		}
		return parse(result)
	} finally {
		if (typeof dispose === 'function') dispose.call(result)
	}
}

function assertManagementTarget(
	value: RpcStub<RuntimeManagementTarget>,
): asserts value is RpcStub<RuntimeManagementTarget> {
	if ((!value || typeof value !== 'object') && typeof value !== 'function') {
		throw new TypeError("Management target must be a Cap'n Web stub")
	}
}
