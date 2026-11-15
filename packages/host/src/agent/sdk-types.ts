import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { Result } from '@pluxel/core/better-result'
import type { LogCursor, LogReadOptions, LogStreamMeta } from '@pluxel/core/logging'
import type { HostConfigMutation } from '../config'
import type { HostOperationOptions } from '../coordinator'
import type { PluginApplyReportSnapshot } from '../apply-report'
import type { HostPluginStatusSnapshot } from '../status'
import type { HostPolicyField, HostPolicyInput } from '../policy'
import type { RuntimeUpdateSnapshot } from '../execution'
import type {
	ScriptRunError,
	ScriptOperationError,
	ScriptTargetError,
	ScriptConfigSnapshot,
	ScriptConfigError,
	ScriptPolicySnapshot,
	ScriptPolicyError,
	ScriptInstanceError,
	ScriptLifecycleError,
	ScriptLogSnapshot,
	ScriptLogError,
	ScriptInspectionError,
} from './sdk-results'
import type {
	Inspection,
	InspectionPluginOptions,
	InspectionPluginReport,
	InspectionPluginSection,
} from './inspection'
import type {
	ScriptPluginListOptions,
	ScriptPluginSnapshot,
	ScriptPluginListError,
} from './discovery'
export type {
	ScriptPluginListOptions,
	ScriptPluginSnapshot,
	ScriptPluginListError,
} from './discovery'
import type {
	PluginTypedNodeAddress,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
	PluginAddressEvidence,
	ConfiguredPlugin,
	SinglePluginConfig,
} from './control'

/** Explicit input and cooperative cancellation for one script invocation. */
export type ScriptContext = Readonly<{
	id: string
	/** Untrusted portable input; validate it for the task before use. */
	input: unknown
	signal: AbortSignal
}>

/** Return JSON or a shared Better Result; a domain Err remains a successful script execution. */
export type Script = (sdk: ScriptSdk, run: ScriptContext) => unknown | Promise<unknown>

/**
 * Configuration for one selected Plugin node. Methods capture their target and can
 * be destructured without binding `this`. Await business calls before using them.
 * Expected failures use Better Result. Unknown defects and invalid argument shapes reject.
 */
export interface ScriptPluginConfig<
	I = Readonly<Record<string, unknown>>,
	O extends object = Readonly<Record<string, unknown>>,
> {
	/** Includes raw input, sources, revision and desired/applied configuration facts. */
	readonly get: () => Promise<Result<ScriptConfigSnapshot<O>, ScriptConfigError>>
	/** Preview validation; application still describes the currently adopted configuration. */
	readonly validate: (
		change: HostConfigMutation<I>,
	) => Promise<Result<ScriptConfigSnapshot<O>, ScriptConfigError>>
	/**
	 * Save managed input and report its adoption. Use expectedManagedRevision for CAS;
	 * inspect the domain result and application report before continuing.
	 */
	readonly patch: (
		change: HostConfigMutation<I>,
		options?: HostOperationOptions,
	) => Promise<Result<ScriptConfigSnapshot<O>, ScriptConfigError>>
	/** Omitted paths reset all managed input; an empty list changes nothing. */
	readonly reset: (
		paths?: readonly (readonly string[])[],
		options?: HostOperationOptions,
	) => Promise<Result<ScriptConfigSnapshot<O>, ScriptConfigError>>
}

/** Freeze identity fields while retaining the declaration-only configuration and instance associations. */
type SelectedAddress<T extends PluginNodeAddress> = {
	readonly [K in keyof T]: K extends 'definition'
		? {
				readonly [D in keyof T['definition']]: D extends 'entry'
					? Readonly<T['definition'][D]>
					: T['definition'][D]
			}
		: T[K]
}

interface ScriptPluginOperations<T extends PluginNodeAddress> {
	/** Immutable selection; retains the input's types and evidence when selected again. */
	readonly address: SelectedAddress<T>
	/** Read current state, or null when this node is absent. */
	readonly status: () => Promise<
		Result<HostPluginStatusSnapshot | null, ScriptOperationError | ScriptTargetError>
	>
	/** Start this node and return the actual lifecycle report. */
	readonly start: () => Promise<Result<PluginApplyReportSnapshot, ScriptLifecycleError>>
	/** Stop this node after draining accepted generation work. */
	readonly stop: () => Promise<Result<PluginApplyReportSnapshot, ScriptLifecycleError>>
	/** Restart this node; previously borrowed business instance views become stale. */
	readonly restart: () => Promise<Result<PluginApplyReportSnapshot, ScriptLifecycleError>>
}

type TypedPluginOperations<T extends PluginTypedNodeAddress> = {
	/**
	 * Borrow the current generation without starting it. Result safely delivers Plugins
	 * with a `then` member. Reacquire after restart; public members preserve the
	 * original class signatures, property mutability and JavaScript receiver behavior.
	 */
	readonly instance: () => Promise<Result<PluginInstance<T>, ScriptInstanceError>>
} & (ConfiguredPlugin<T> extends never
	? unknown
	: {
			/** Validated configuration for this target; an unresolved union permits reads only. */
			readonly config: SinglePluginConfig<T> extends never
				? Pick<ScriptPluginConfig<PluginConfigInput<T>, PluginConfigOutput<T>>, 'get'>
				: ScriptPluginConfig<PluginConfigInput<T>, PluginConfigOutput<T>>
		})

type AddressOperations<T extends PluginNodeAddress> = [T] extends [PluginTypedNodeAddress]
	? TypedPluginOperations<T>
	: ([T] extends [PluginAddressEvidence<T>['target']]
			? {
					readonly instance: () => Promise<Result<PluginInstance<T>, ScriptInstanceError>>
				}
			: unknown) &
			([Extract<PluginAddressEvidence<T>, { kind: 'control' }>] extends [never]
				? { readonly config: ScriptPluginConfig }
				: unknown)

/**
 * Immutable, run-scoped selection of one Plugin node. It holds an address and the
 * descriptor contracts, while each operation resolves current committed Host state.
 * All control functions are safe to extract. Closing the run revokes their admission.
 * Generated addresses provide typed configuration and business instance access;
 * source class addresses retain their original instance type. Source class and plain
 * discovered addresses provide configuration with unknown fields. Mixing generated and
 * other address kinds requires narrowing; typed configuration unions permit writes only
 * with one schema association.
 */
export type ScriptPlugin<T extends PluginNodeAddress = PluginNodeAddress> =
	ScriptPluginOperations<T> & AddressOperations<T>

/** Source resolution is fixed by the execution target; another application is an offline query. */
export type ScriptInspectionOptions = Omit<InspectionPluginOptions, 'application'>

export interface ScriptPluginInspect {
	(
		target: PluginDefinitionAddress,
		options?: ScriptInspectionOptions & { readonly include?: readonly [] },
	): Promise<Result<Inspection<InspectionPluginReport<readonly []>>, ScriptInspectionError>>
	<const S extends readonly InspectionPluginSection[]>(
		target: PluginDefinitionAddress,
		options: ScriptInspectionOptions & { readonly include: S },
	): Promise<Result<Inspection<InspectionPluginReport<S>>, ScriptInspectionError>>
	<const S extends readonly InspectionPluginSection[]>(
		target: PluginDefinitionAddress,
		options: ScriptInspectionOptions & { readonly include?: S },
	): Promise<
		Result<Inspection<InspectionPluginReport<readonly S[number][]>>, ScriptInspectionError>
	>
}

/**
 * Host operations return promises of the shared Better Result; Plugin address selection
 * is synchronous. Closing the run denies new calls and waits for accepted work;
 * it does not undo mutations.
 * Management values are snapshots. Business instance views admit each member access
 * in this scope and execute on the original provider object. Await business work
 * before the script finishes; nested resources retain their original ownership.
 */
export interface ScriptSdk {
	/**
	 * Inspect a concrete or abstract definition in the target environment's current disk source.
	 * Pass dependency definitions directly, or node.address.definition after discovery.
	 * No running node, constructor evidence, or runtime-version match is required or inferred.
	 * The lightweight default returns the declaration; include selects additional source sections.
	 */
	readonly inspect: ScriptPluginInspect
	/**
	 * Select a Plugin synchronously, without reading Host state or starting it. Captures
	 * a validated target snapshot. The selector and all reference methods can be cached
	 * within this run without binding `this`; a closed run rejects further selection.
	 * Malformed targets and closed runs throw synchronously. Async expected failures
	 * return Err; unknown implementation defects reject. Detached address evidence is rejected before normalization.
	 *
	 * @example
	 * const plugin = sdk.plugin
	 * const counter = plugin(Counter.nodeAddress('tenant-a'))
	 * const { get, patch } = counter.config
	 */
	readonly plugin: <const T extends PluginNodeAddress>(target: T) => ScriptPlugin<T>
	readonly plugins: {
		/** Discover one bounded page; reuse nextCursor while this Host and its revisions are unchanged. */
		readonly list: (
			options?: ScriptPluginListOptions,
		) => Promise<Result<ScriptPluginSnapshot, ScriptPluginListError>>
	}
	readonly policy: {
		readonly get: () => Promise<Result<ScriptPolicySnapshot, ScriptPolicyError>>
		readonly validate: (
			values: HostPolicyInput,
		) => Promise<Result<ScriptPolicySnapshot, ScriptPolicyError>>
		readonly patch: (
			values: HostPolicyInput,
			options?: HostOperationOptions,
		) => Promise<Result<ScriptPolicySnapshot, ScriptPolicyError>>
		readonly reset: (
			keys?: readonly HostPolicyField[],
			options?: HostOperationOptions,
		) => Promise<Result<ScriptPolicySnapshot, ScriptPolicyError>>
	}
	readonly updates: {
		readonly latest: () => Promise<Result<RuntimeUpdateSnapshot | null, ScriptRunError>>
	}
	readonly logs: {
		/** Configured history streams, including empty streams. Does not add a sink. */
		readonly streams: () => Promise<
			Result<Readonly<{ rootId: string; streams: readonly LogStreamMeta[] }>, ScriptLogError>
		>
		/** Mark the stream end. @defaultValue streamId "default" */
		readonly mark: (streamId?: string) => Promise<Result<LogCursor, ScriptLogError>>
		/** Preserves reset, replacement and retention-gap errors. @defaultValue limit 100 */
		readonly read: (
			cursor: LogCursor,
			options?: LogReadOptions,
		) => Promise<Result<ScriptLogSnapshot, ScriptLogError>>
		/**
		 * Wait at most timeoutMs (1..300000) for a matching batch. Timeout returns an empty
		 * read; cancellation returns Err and releases the subscription. Maximum limit 10000.
		 */
		readonly wait: (
			cursor: LogCursor,
			options: LogReadOptions & Readonly<{ timeoutMs: number }>,
		) => Promise<Result<ScriptLogSnapshot, ScriptLogError>>
	}
}
