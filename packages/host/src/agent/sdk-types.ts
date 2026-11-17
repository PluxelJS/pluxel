import type { PluginNodeAddress, ServiceAccess, ServiceDefinition, ServiceRef } from '@pluxel/core'
import type { LogCursor, LogReadOptions, LogStreamMeta } from '@pluxel/core/logging'
import type { HostConfigMutation } from '../config'
import type { HostOperationOptions } from '../coordinator'
import type { PluginApplyReportSnapshot } from '../apply-report'
import type { HostPluginStatusSnapshot } from '../status'
import type { HostPolicyField, HostPolicyInput } from '../policy'
import type { RuntimeUpdateSnapshot } from '../execution'
import type { ScriptConfigSnapshot, ScriptPolicySnapshot, ScriptLogSnapshot } from './sdk-outcomes'
import type { ScriptPluginListOptions, ScriptPluginSnapshot } from './discovery'
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
 * Control failures throw ScriptError with domain details; invalid arguments and unknown defects retain their original errors.
 */
export interface ScriptPluginConfig<
	I = Readonly<Record<string, unknown>>,
	O extends object = Readonly<Record<string, unknown>>,
> {
	/** Includes raw input, sources, revision and desired/applied configuration facts. */
	readonly get: () => Promise<ScriptConfigSnapshot<O>>
	/** Preview validation; application still describes the currently adopted configuration. */
	readonly validate: (change: HostConfigMutation<I>) => Promise<ScriptConfigSnapshot<O>>
	/**
	 * Save managed input and report its adoption. Use expectedManagedRevision for CAS;
	 * inspect the domain result and application report before continuing.
	 */
	readonly patch: (
		change: HostConfigMutation<I>,
		options?: HostOperationOptions,
	) => Promise<ScriptConfigSnapshot<O>>
	/** Omitted paths reset all managed input; an empty list changes nothing. */
	readonly reset: (
		paths?: readonly (readonly string[])[],
		options?: HostOperationOptions,
	) => Promise<ScriptConfigSnapshot<O>>
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

/** A run-scoped service accessor. Returned values retain the selected Context's ownership. */
export interface ScriptServiceContext<TAccess extends ServiceAccess = ServiceAccess> {
	service<T>(definition: ServiceDefinition<T, TAccess>): T
	service<T>(ref: ServiceRef<T>): T | undefined
}

interface ScriptPluginOperations<T extends PluginNodeAddress> {
	/** Immutable selection; retains the input's types and evidence when selected again. */
	readonly address: SelectedAddress<T>
	/** Read current state, or null when this node is absent. */
	readonly status: () => Promise<HostPluginStatusSnapshot | null>
	/** Borrow the current running generation; reacquire after restart or replacement. */
	readonly context: () => Promise<ScriptServiceContext<'all' | 'owner'>>
	/** Start this node and return the actual lifecycle report. */
	readonly start: () => Promise<PluginApplyReportSnapshot>
	/** Stop this node after draining accepted generation work. */
	readonly stop: () => Promise<PluginApplyReportSnapshot>
	/** Restart this node; previously borrowed business instance views become stale. */
	readonly restart: () => Promise<PluginApplyReportSnapshot>
}

type TypedPluginOperations<T extends PluginTypedNodeAddress> = {
	/**
	 * Borrow the current generation without starting it. The { instance } envelope safely
	 * delivers Plugins with a business `then` member. Reacquire after restart; public members preserve the
	 * original class signatures, property mutability and JavaScript receiver behavior.
	 */
	readonly instance: () => Promise<Readonly<{ instance: PluginInstance<T> }>>
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
					readonly instance: () => Promise<Readonly<{ instance: PluginInstance<T> }>>
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

/**
 * Host operations return values and throw ScriptError on control failures; Plugin address
 * selection is synchronous. Closing the run denies new calls and waits for accepted work;
 * it does not undo mutations.
 * Management values are snapshots. Business instance views admit each member access
 * in this scope and execute on the original provider object. Await business work
 * before the script finishes; nested resources retain their original ownership.
 */
export interface ScriptSdk {
	/** Root service access for this run. Optional refs return undefined only when absent. */
	readonly ctx: ScriptServiceContext<'all' | 'root'>
	/**
	 * Select a Plugin synchronously, without reading Host state or starting it. Captures
	 * a validated target snapshot. The selector and all reference methods can be cached
	 * within this run without binding `this`; a closed run rejects further selection.
	 * Malformed targets and closed runs throw synchronously. Async control failures
	 * reject with ScriptError; unknown implementation defects retain their original errors. Detached address evidence is rejected before normalization.
	 *
	 * @example
	 * const plugin = sdk.plugin
	 * const counter = plugin(Counter.nodeAddress('tenant-a'))
	 * const { get, patch } = counter.config
	 */
	readonly plugin: <const T extends PluginNodeAddress>(target: T) => ScriptPlugin<T>
	readonly plugins: {
		/** Discover one bounded page; reuse nextCursor while this Host and its revisions are unchanged. */
		readonly list: (options?: ScriptPluginListOptions) => Promise<ScriptPluginSnapshot>
	}
	readonly policy: {
		readonly get: () => Promise<ScriptPolicySnapshot>
		readonly validate: (values: HostPolicyInput) => Promise<ScriptPolicySnapshot>
		readonly patch: (
			values: HostPolicyInput,
			options?: HostOperationOptions,
		) => Promise<ScriptPolicySnapshot>
		readonly reset: (
			keys?: readonly HostPolicyField[],
			options?: HostOperationOptions,
		) => Promise<ScriptPolicySnapshot>
	}
	readonly updates: {
		readonly latest: () => Promise<RuntimeUpdateSnapshot | null>
	}
	readonly logs: {
		/** Configured history streams, including empty streams. Does not add a sink. */
		readonly streams: () => Promise<Readonly<{ rootId: string; streams: readonly LogStreamMeta[] }>>
		/** Mark the stream end. @defaultValue streamId "default" */
		readonly mark: (streamId?: string) => Promise<LogCursor>
		/** Preserves reset, replacement and retention-gap errors. @defaultValue limit 100 */
		readonly read: (cursor: LogCursor, options?: LogReadOptions) => Promise<ScriptLogSnapshot>
		/**
		 * Wait at most timeoutMs (1..300000) for a matching batch. Timeout returns an empty
		 * read; cancellation throws ScriptError and releases the subscription. Maximum limit 10000.
		 */
		readonly wait: (
			cursor: LogCursor,
			options: LogReadOptions & Readonly<{ timeoutMs: number }>,
		) => Promise<ScriptLogSnapshot>
	}
}
