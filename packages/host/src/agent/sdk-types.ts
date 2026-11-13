import type { PluginNodeAddress } from '@pluxel/core'
import type { LogCursor, LogReadOptions, LogReadResult, LogStreamMeta } from '@pluxel/core/logging'
import type { HostConfigMutation, HostPluginConfigResult } from '../config'
import type { HostOperationOptions } from '../coordinator'
import type { PluginApplyReportSnapshot } from '../apply-report'
import type { HostPluginStatusSnapshot } from '../status'
import type { HostPolicyField, HostPolicyInput } from '../policy'
import type { HostPolicyResult } from '../policy-management'
import type { RuntimeUpdateSnapshot } from '../execution'

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
 * Values are snapshots. Node addresses identify installed definitions, never instances.
 */
export interface ScriptSdk {
	readonly plugins: {
		list(): Promise<readonly HostPluginStatusSnapshot[]>
		status(node: PluginNodeAddress): Promise<HostPluginStatusSnapshot | null>
		start(node: PluginNodeAddress): Promise<PluginApplyReportSnapshot>
		stop(node: PluginNodeAddress): Promise<PluginApplyReportSnapshot>
		restart(node: PluginNodeAddress): Promise<PluginApplyReportSnapshot>
	}
	readonly config: {
		/** Includes raw input, sources, revision and desired/applied configuration facts. */
		get(node: PluginNodeAddress): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		validate(
			node: PluginNodeAddress,
			change: HostConfigMutation,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		patch(
			node: PluginNodeAddress,
			change: HostConfigMutation,
			options?: HostOperationOptions,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		/** Omitted paths reset all managed input; an empty list changes nothing. */
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
		read(cursor: LogCursor, options?: LogReadOptions): Promise<LogReadResult>
		/**
		 * Wait at most timeoutMs (1..300000) for a matching batch. Timeout returns an empty
		 * read; run cancellation rejects and releases the subscription. Maximum limit 10000.
		 */
		wait(
			cursor: LogCursor,
			options: LogReadOptions & Readonly<{ timeoutMs: number }>,
		): Promise<LogReadResult>
	}
}
