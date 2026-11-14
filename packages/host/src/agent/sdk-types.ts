import type { PluginNodeAddress } from '@pluxel/core'
import type { LogCursor, LogReadResult, LogStreamMeta } from '@pluxel/core/logging'
import type { HostConfigMutation, HostPluginConfigResult } from '../config'
import type { HostOperationOptions } from '../coordinator'
import type { PluginApplyReportSnapshot } from '../apply-report'
import type { HostPluginStatusSnapshot } from '../status'
import type { HostPolicyField, HostPolicyInput } from '../policy'
import type { HostPolicyResult } from '../policy-management'
import type { RuntimeUpdateSnapshot } from '../execution'
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

/** Ordinary JavaScript; a returned domain failure is still a successful script result. */
export type Script = (sdk: ScriptSdk, run: ScriptContext) => unknown | Promise<unknown>

/**
 * Configuration for one selected Plugin node. Methods capture their target and can
 * be destructured without binding `this`. Await business calls before using them.
 * Domain failures remain ordinary Host results; cancellation and scope errors reject.
 */
export interface ScriptPluginConfig<
	I = Readonly<Record<string, unknown>>,
	O extends object = Readonly<Record<string, unknown>>,
> {
	/** Includes raw input, sources, revision and desired/applied configuration facts. */
	readonly get: () => Promise<HostPluginConfigResult<PluginApplyReportSnapshot, O>>
	/** Preview validation; application still describes the currently adopted configuration. */
	readonly validate: (
		change: HostConfigMutation<I>,
	) => Promise<HostPluginConfigResult<PluginApplyReportSnapshot, O>>
	/**
	 * Save managed input and report its adoption. Use expectedManagedRevision for CAS;
	 * inspect the domain result and application report before continuing.
	 */
	readonly patch: (
		change: HostConfigMutation<I>,
		options?: HostOperationOptions,
	) => Promise<HostPluginConfigResult<PluginApplyReportSnapshot, O>>
	/** Omitted paths reset all managed input; an empty list changes nothing. */
	readonly reset: (
		paths?: readonly (readonly string[])[],
		options?: HostOperationOptions,
	) => Promise<HostPluginConfigResult<PluginApplyReportSnapshot, O>>
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
	readonly status: () => Promise<HostPluginStatusSnapshot | null>
	/** Start this node and return the actual lifecycle report. */
	readonly start: () => Promise<PluginApplyReportSnapshot>
	/** Stop this node after draining accepted generation work. */
	readonly stop: () => Promise<PluginApplyReportSnapshot>
	/** Restart this node; previously borrowed business instance views become stale. */
	readonly restart: () => Promise<PluginApplyReportSnapshot>
}

type TypedPluginOperations<T extends PluginTypedTarget> = {
	/**
	 * Borrow the current generation without starting it. The envelope safely delivers
	 * Plugins with a `then` member. Reacquire after restart; public members preserve the
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
 * Host operations borrowed by one run return ordinary promises; plugin/fork selection
 * is synchronous. Closing the run rejects new calls and waits for accepted work;
 * it does not undo mutations.
 * Management values are snapshots. Business instance views admit each member access
 * in this scope and execute on the original provider object. Await business work
 * before the script finishes; nested resources retain their original ownership.
 */
export interface ScriptSdk {
	/**
	 * Select a Plugin synchronously, without reading Host state or starting it. Captures
	 * a validated target snapshot. The selector and all reference methods can be cached
	 * within this run without binding `this`; a closed run rejects further selection.
	 * Malformed targets and closed runs throw synchronously; Host operations reject
	 * their promises. Unsupported descriptor formats report `control_format_unsupported`.
	 *
	 * @example
	 * const plugin = sdk.plugin
	 * const counter = plugin(Counter).fork('tenant-a')
	 * const { get, patch } = counter.config
	 */
	readonly plugin: <const T extends PluginTarget>(target: T) => ScriptPlugin<T>
	readonly plugins: {
		/** Discover current node addresses, lifecycle state and diagnostics. */
		readonly list: () => Promise<readonly HostPluginStatusSnapshot[]>
	}
	readonly policy: {
		readonly get: () => Promise<HostPolicyResult<PluginApplyReportSnapshot>>
		readonly validate: (
			values: HostPolicyInput,
		) => Promise<HostPolicyResult<PluginApplyReportSnapshot>>
		readonly patch: (
			values: HostPolicyInput,
			options?: HostOperationOptions,
		) => Promise<HostPolicyResult<PluginApplyReportSnapshot>>
		readonly reset: (
			keys?: readonly HostPolicyField[],
			options?: HostOperationOptions,
		) => Promise<HostPolicyResult<PluginApplyReportSnapshot>>
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
		readonly read: (cursor: LogCursor, options?: ScriptLogReadOptions) => Promise<LogReadResult>
		/**
		 * Wait at most timeoutMs (1..300000) for a matching batch. Timeout returns an empty
		 * read; run cancellation rejects and releases the subscription. Maximum limit 10000.
		 */
		readonly wait: (
			cursor: LogCursor,
			options: ScriptLogReadOptions & Readonly<{ timeoutMs: number }>,
		) => Promise<LogReadResult>
	}
}
