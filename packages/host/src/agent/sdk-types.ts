import type { PluginNodeAddress } from '@pluxel/core'
import type { Result } from '@pluxel/core/better-result'
import type { LogCursor, LogStreamMeta } from '@pluxel/core/logging'
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
} from './sdk-results'
import type {
	PluginTypedTarget,
	PluginTarget,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
	ConfiguredPlugin,
	SinglePluginConfig,
	ScriptLogReadOptions,
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

interface ScriptPluginOperations<T extends PluginTarget> {
	/** Frozen address selected by this reference; suitable for native log filters. */
	readonly address: PluginNodeAddress
	/**
	 * Select another fork of this definition. Returns a new reference, without creating
	 * or starting a node. Repeated calls replace the fork ID and preserve this reference.
	 * Throws synchronously for an invalid ID or a closed run (`scope_closed`).
	 */
	readonly fork: (forkId: string) => ScriptPlugin<T>
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

type TypedPluginOperations<T extends PluginTypedTarget> = {
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

/**
 * Immutable, run-scoped selection of one Plugin node. It holds an address and the
 * descriptor contracts, while each operation resolves current committed Host state.
 * All control functions are safe to extract. Closing the run revokes their admission.
 * Generated descriptors provide typed configuration and business instance access;
 * discovered addresses provide configuration with unknown fields. Narrow descriptor
 * unions before selection to mutate variant-specific configuration.
 */
export type ScriptPlugin<T extends PluginTarget = PluginTarget> = ScriptPluginOperations<T> &
	([T] extends [PluginTypedTarget]
		? TypedPluginOperations<T>
		: [T] extends [PluginNodeAddress]
			? { readonly config: ScriptPluginConfig }
			: unknown)

/**
 * Host operations return promises of the shared Better Result; plugin/fork selection
 * is synchronous. Closing the run denies new calls and waits for accepted work;
 * it does not undo mutations.
 * Management values are snapshots. Business instance views admit each member access
 * in this scope and execute on the original provider object. Await business work
 * before the script finishes; nested resources retain their original ownership.
 */
export interface ScriptSdk {
	/** Original shared Better Result namespace. Use gen/await to short-circuit workflows. */
	readonly Result: typeof Result
	/**
	 * Select a Plugin synchronously, without reading Host state or starting it. Captures
	 * a validated target snapshot. The selector and all reference methods can be cached
	 * within this run without binding `this`; a closed run rejects further selection.
	 * Malformed targets and closed runs throw synchronously. Async expected failures
	 * return Err; unknown implementation defects reject. Unsupported descriptor formats
	 * report `control_format_unsupported`.
	 *
	 * @example
	 * const plugin = sdk.plugin
	 * const counter = plugin(Counter).fork('tenant-a')
	 * const { get, patch } = counter.config
	 */
	readonly plugin: <const T extends PluginTarget>(target: T) => ScriptPlugin<T>
	readonly plugins: {
		/** Discover current node addresses, lifecycle state and diagnostics. */
		readonly list: () => Promise<Result<readonly HostPluginStatusSnapshot[], ScriptOperationError>>
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
			options?: ScriptLogReadOptions,
		) => Promise<Result<ScriptLogSnapshot, ScriptLogError>>
		/**
		 * Wait at most timeoutMs (1..300000) for a matching batch. Timeout returns an empty
		 * read; cancellation returns Err and releases the subscription. Maximum limit 10000.
		 */
		readonly wait: (
			cursor: LogCursor,
			options: ScriptLogReadOptions & Readonly<{ timeoutMs: number }>,
		) => Promise<Result<ScriptLogSnapshot, ScriptLogError>>
	}
}
