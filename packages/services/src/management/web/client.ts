import type { HostConfigState, HostPolicyInput, HostPolicyField } from '@pluxel/host'
import {
	cloneRuntimeUpdateSnapshot,
	type RuntimeUpdateSnapshot,
} from '@pluxel/host/internal/protocol'
import {
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { type RpcStub } from 'capnweb'
import {
	type ConfigFieldMutation,
	type ConfigPatch,
	type ManagedInputMutationOptions,
	type ConfigPresentationResult,
	type ConfigResult,
	type PolicyResult,
	type EnsureForkResult,
	type LoggingHandleApi,
	type PluginAutoStartBatchItem,
	type PluginConsumerRequirementsInspectionResult,
	type PluginControlBatchResult,
	type PluginDependencyGraphSnapshot,
	type PluginDependencyMutationResult,
	type PluginCatalogLayoutInput,
	type PluginCatalogLayoutMutationResult,
	type PluginCatalogSnapshot,
	type PluginLifecycleCommandBatchItem,
	type PluginProviderPolicyInspectionResult,
	type PluginStatusQueryResult,
	type RemoveForkResult,
	type RuntimeMeta,
} from './protocol'
import {
	type RuntimeLogFollowInput,
	type RuntimeLogRangeQuery,
	type RuntimeLogStreamsIndex,
	type RuntimeManagementTarget,
} from './management-target'
import {
	type LogRangeResult,
	type LogStreamMeta,
	type RuntimeLogEvent,
} from '@pluxel/core/logging/protocol'
import { type RuntimeSecurityClient } from './security'
import {
	parseConfigPresentationResult,
	parseConfigResult,
	parsePolicyResult,
	parseConfigState,
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
import { parseRuntimeMeta, validateRuntimePortableData } from './validation'
import {
	parsePluginControlManifestIndex,
	parsePluginControlFileChunk,
	ScriptExecutionError,
	type PluginControlManifestIndex,
	type PluginControlManifestRequest,
	type PluginControlFileRequest,
	type PluginControlFileChunk,
} from '@pluxel/host/agent'

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
	materials: Readonly<{
		manifest(input?: PluginControlManifestRequest): Promise<PluginControlManifestIndex>
		file(input: PluginControlFileRequest): Promise<PluginControlFileChunk>
	}>
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
		setAutoStart(
			items: readonly PluginAutoStartBatchItem[],
			options?: ManagedInputMutationOptions,
		): Promise<PluginControlBatchResult>
		applyLifecycleCommands(
			items: readonly PluginLifecycleCommandBatchItem[],
		): Promise<PluginControlBatchResult>
	}>
	config: Readonly<{
		status(): Promise<HostConfigState>
		presentation(owner: PluginNodeAddress): Promise<ConfigPresentationResult>
		get(owner: PluginNodeAddress): Promise<ConfigResult>
		validate(
			owner: PluginNodeAddress,
			patch: ConfigPatch,
			options?: ManagedInputMutationOptions,
		): Promise<ConfigResult>
		patch(
			owner: PluginNodeAddress,
			patch: ConfigPatch,
			options?: ManagedInputMutationOptions,
		): Promise<ConfigResult>
		reset(
			owner: PluginNodeAddress,
			paths?: readonly (readonly string[])[],
			options?: ManagedInputMutationOptions,
		): Promise<ConfigResult>
		patchField(
			owner: PluginNodeAddress,
			input: ConfigFieldMutation,
			options?: ManagedInputMutationOptions,
		): Promise<ConfigResult>
	}>
	policy: Readonly<{
		get(): Promise<PolicyResult>
		validate(values: HostPolicyInput): Promise<PolicyResult>
		patch(values: HostPolicyInput, options?: ManagedInputMutationOptions): Promise<PolicyResult>
		reset(
			keys?: readonly HostPolicyField[],
			options?: ManagedInputMutationOptions,
		): Promise<PolicyResult>
	}>
	dependencies: Readonly<{
		graph(): Promise<PluginDependencyGraphSnapshot>
		inspectConsumerRequirements(
			consumer: PluginNodeAddress,
		): Promise<PluginConsumerRequirementsInspectionResult>
		setConsumerOverride(
			input: {
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
				provider: PluginNodeAddress | null
			},
			options?: ManagedInputMutationOptions,
		): Promise<PluginDependencyMutationResult>
		inspectProviderPolicy(
			policyOwner: PluginNodeAddress,
		): Promise<PluginProviderPolicyInspectionResult>
		setProviderPolicyDefault(
			input: {
				policyOwner: PluginNodeAddress
				provider: PluginNodeAddress | null
			},
			options?: ManagedInputMutationOptions,
		): Promise<PluginDependencyMutationResult>
	}>
	forks: Readonly<{
		ensure(
			input: {
				fork: PluginForkNodeAddress
				autoStart?: boolean
				selectFor?: {
					consumer: PluginNodeAddress
					requirement: PluginDefinitionAddress
				}
			},
			options?: ManagedInputMutationOptions,
		): Promise<EnsureForkResult>
		remove(
			fork: PluginForkNodeAddress,
			options?: ManagedInputMutationOptions,
		): Promise<RemoveForkResult>
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
		materials: Object.freeze({
			manifest: (input) =>
				call(
					(root) => root.pluginControlManifestDto(input),
					(value) => materialResponse(value, parsePluginControlManifestIndex),
				),
			file: (input) =>
				call(
					(root) => root.pluginControlFileDto(input),
					(value) => materialResponse(value, parsePluginControlFileChunk),
				),
		}),
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
			setAutoStart: (items, options) =>
				call(
					(root) => root.setPluginAutoStartDto([...items], options),
					parsePluginControlBatchResult,
				),
			applyLifecycleCommands: (items) =>
				call(
					(root) => root.applyPluginLifecycleCommandsDto([...items]),
					parsePluginControlBatchResult,
				),
		}),
		config: Object.freeze({
			status: () => call((root) => root.configStateDto(), parseConfigState),
			presentation: (owner) =>
				call((root) => root.pluginConfigPresentationDto(owner), parseConfigPresentationResult),
			get: (owner) => call((root) => root.pluginConfigDto(owner), parseConfigResult),
			validate: (owner, patch, options) =>
				call((root) => root.validatePluginConfigDto(owner, patch, options), parseConfigResult),
			patch: (owner, patch, options) =>
				call((root) => root.patchPluginConfigDto(owner, patch, options), parseConfigResult),
			reset: (owner, paths, options) =>
				call((root) => root.resetPluginConfigDto(owner, paths, options), parseConfigResult),
			patchField: (owner, input, options) =>
				call((root) => root.patchPluginConfigFieldDto(owner, input, options), parseConfigResult),
		}),
		policy: Object.freeze({
			get: () => call((root) => root.hostPolicyDto(), parsePolicyResult),
			validate: (values) => call((root) => root.validateHostPolicyDto(values), parsePolicyResult),
			patch: (values, options) =>
				call((root) => root.patchHostPolicyDto(values, options), parsePolicyResult),
			reset: (keys, options) =>
				call((root) => root.resetHostPolicyDto(keys, options), parsePolicyResult),
		}),
		dependencies: Object.freeze({
			graph: () =>
				call((root) => root.pluginDependencyGraphDto(), parsePluginDependencyGraphSnapshot),
			inspectConsumerRequirements: (consumer) =>
				call(
					(root) => root.inspectPluginConsumerRequirementsDto(consumer),
					parsePluginConsumerRequirementsInspectionResult,
				),
			setConsumerOverride: (input, options) =>
				call(
					(root) => root.setPluginConsumerOverrideDto(input, options),
					parsePluginDependencyMutationResult,
				),
			inspectProviderPolicy: (policyOwner) =>
				call(
					(root) => root.inspectPluginProviderPolicyDto(policyOwner),
					parsePluginProviderPolicyInspectionResult,
				),
			setProviderPolicyDefault: (input, options) =>
				call(
					(root) => root.setPluginProviderPolicyDefaultDto(input, options),
					parsePluginDependencyMutationResult,
				),
		}),
		forks: Object.freeze({
			ensure: (input, options) =>
				call((root) => root.ensurePluginForkDto(input, options), parseEnsureForkResult),
			remove: (input, options) =>
				call((root) => root.removePluginForkDto(input, options), parseRemoveForkResult),
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

function materialResponse<T>(input: unknown, parse: (value: unknown) => T): T {
	validateRuntimePortableData(input, 'control material response')
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new TypeError('Invalid control material response')
	const value = input as Record<string, unknown>
	if (value.ok === true && Object.keys(value).length === 2 && Object.hasOwn(value, 'value'))
		return parse(value.value)
	if (
		value.ok === false &&
		Object.keys(value).length === 2 &&
		value.error &&
		typeof value.error === 'object'
	) {
		const error = value.error as Record<string, unknown>
		if (
			typeof error.code === 'string' &&
			typeof error.message === 'string' &&
			Object.keys(error).every((key) => ['code', 'message', 'stack'].includes(key)) &&
			(error.stack === undefined || typeof error.stack === 'string')
		) {
			const failure = new ScriptExecutionError(error.code, error.message)
			if (typeof error.stack === 'string') failure.stack = error.stack
			throw failure
		}
	}
	throw new TypeError('Invalid control material response envelope')
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
