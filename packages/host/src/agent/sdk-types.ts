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
 * Host operations borrowed by one run. All methods return ordinary promises. Closing
 * the run rejects new calls and waits for accepted work; it does not undo mutations.
 * Management values are snapshots. Business instance views admit each member access
 * in this scope and execute on the original provider object. Await business work
 * before the script finishes; nested resources retain their original ownership.
 */
export interface ScriptSdk {
	readonly plugins: {
		list(): Promise<readonly HostPluginStatusSnapshot[]>
		status(target: PluginTarget): Promise<HostPluginStatusSnapshot | null>
		start(target: PluginTarget): Promise<PluginApplyReportSnapshot>
		stop(target: PluginTarget): Promise<PluginApplyReportSnapshot>
		restart(target: PluginTarget): Promise<PluginApplyReportSnapshot>
		/**
		 * Borrow the current generation's public instance surface without starting it.
		 * The envelope safely delivers Plugins that define a `then` member. Original
		 * property mutability and synchronous/async method signatures are preserved.
		 */
		instance<const T extends PluginTypedTarget>(
			target: T,
		): Promise<Readonly<{ instance: PluginInstance<T> }>>
	}
	readonly config: {
		/** Includes raw input, sources, revision and desired/applied configuration facts. */
		get<const T extends PluginTypedTarget>(
			target: T & ConfiguredPlugin<T>,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot, PluginConfigOutput<T>>>
		get(node: PluginNodeAddress): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		/** Preview validation; application still describes the currently adopted configuration. */
		validate<const T extends PluginTypedTarget>(
			target: T & ConfiguredPlugin<T> & SinglePluginConfig<T>,
			change: HostConfigMutation<NoInfer<PluginConfigInput<T>>>,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot, PluginConfigOutput<T>>>
		validate(
			node: PluginNodeAddress,
			change: HostConfigMutation,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		patch<const T extends PluginTypedTarget>(
			target: T & ConfiguredPlugin<T> & SinglePluginConfig<T>,
			change: HostConfigMutation<NoInfer<PluginConfigInput<T>>>,
			options?: HostOperationOptions,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot, PluginConfigOutput<T>>>
		patch(
			node: PluginNodeAddress,
			change: HostConfigMutation,
			options?: HostOperationOptions,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		/** Omitted paths reset all managed input; an empty list changes nothing. */
		reset<const T extends PluginTypedTarget>(
			target: T & ConfiguredPlugin<T> & SinglePluginConfig<T>,
			paths?: readonly (readonly string[])[],
			options?: HostOperationOptions,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot, PluginConfigOutput<T>>>
		reset(
			node: PluginNodeAddress,
			paths?: readonly (readonly string[])[],
			options?: HostOperationOptions,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
	}
	readonly policy: {
		get(): Promise<HostPolicyResult<PluginApplyReportSnapshot>>
		validate(values: HostPolicyInput): Promise<HostPolicyResult<PluginApplyReportSnapshot>>
		patch(
			values: HostPolicyInput,
			options?: HostOperationOptions,
		): Promise<HostPolicyResult<PluginApplyReportSnapshot>>
		reset(
			keys?: readonly HostPolicyField[],
			options?: HostOperationOptions,
		): Promise<HostPolicyResult<PluginApplyReportSnapshot>>
	}
	readonly updates: {
		latest(): Promise<RuntimeUpdateSnapshot | null>
	}
	readonly logs: {
		/** Configured history streams, including empty streams. Does not add a sink. */
		streams(): Promise<Readonly<{ rootId: string; streams: readonly LogStreamMeta[] }>>
		/** Mark the stream end. @defaultValue streamId "default" */
		mark(streamId?: string): Promise<LogCursor>
		/** Preserves reset, replacement and retention-gap errors. @defaultValue limit 100 */
		read(cursor: LogCursor, options?: ScriptLogReadOptions): Promise<LogReadResult>
		/**
		 * Wait at most timeoutMs (1..300000) for a matching batch. Timeout returns an empty
		 * read; run cancellation rejects and releases the subscription. Maximum limit 10000.
		 */
		wait(
			cursor: LogCursor,
			options: ScriptLogReadOptions & Readonly<{ timeoutMs: number }>,
		): Promise<LogReadResult>
	}
}
