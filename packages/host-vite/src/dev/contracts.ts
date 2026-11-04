import type { PluginConstructor, PluginNodeAddress, RootContext } from '@pluxel/core'
import type {
	HostPluginStatusSnapshot,
	HostPluginConfigResult,
	PluginApplyReportSnapshot,
	RuntimeUpdateSnapshot,
	HostConfigState,
	HostConfigSource,
	HostConfigMutation,
	HostInputMode,
	HostOperationOptions,
	HostPolicyInput,
	HostPolicyField,
	HostPolicyResult,
} from '@pluxel/host'

/** Current concrete implementation; fork references do not create a fork. */
export type DevTypedPluginTarget<P extends PluginConstructor = PluginConstructor> =
	| P
	| Readonly<{ plugin: P; forkId: string }>
export type DevPluginTarget = DevTypedPluginTarget | PluginNodeAddress
export type DevPluginInstance<T extends DevTypedPluginTarget> = T extends PluginConstructor
	? InstanceType<T>
	: T extends { plugin: infer P extends PluginConstructor }
		? InstanceType<P>
		: never
export type DevScript = (dev: DevConsole) => unknown | Promise<unknown>

export type DevConfigInspection = Readonly<{
	mode: HostInputMode
	readonly: boolean
	externalReload: boolean
	managedInput: Readonly<Record<string, unknown>> | null
	managedRevision: string
	shadowedPaths: readonly (readonly string[])[]
	declared: Readonly<Record<string, unknown>>
	effectiveInput: Readonly<Record<string, unknown>>
	sources: readonly HostConfigSource[]
}>

/** Infer the execution context and preserve the callback return type; does not execute it. */
export function defineDevConsole<T extends DevScript>(script: T): T {
	return script
}

export class DevConsoleError extends Error {
	constructor(
		readonly code: 'scope_closed' | 'target_unavailable' | 'stale_target' | 'plugin_not_running',
		message: string,
	) {
		super(message)
		this.name = 'DevConsoleError'
	}
}

export interface DevConsole {
	/** Identity and untrusted JSON input of this explicit execution. */
	readonly id: string
	readonly input: unknown
	/** Cooperative cancellation; pass explicitly to service operations. */
	readonly signal: AbortSignal
	readonly updates: {
		/** Latest application update, including failures with no known Plugin. */
		latest(): Promise<RuntimeUpdateSnapshot | null>
	}
	/** Borrowed current root, valid only during this run. Acquired objects are not revocable proxies. */
	readonly ctx: RootContext
	readonly plugins: {
		list(): Promise<readonly HostPluginStatusSnapshot[]>
		status(target: DevPluginTarget): Promise<HostPluginStatusSnapshot | null>
		isRunning(target: DevPluginTarget): boolean
		start(target: DevPluginTarget): Promise<PluginApplyReportSnapshot>
		stop(target: DevPluginTarget): Promise<PluginApplyReportSnapshot>
		restart(target: DevPluginTarget): Promise<PluginApplyReportSnapshot>
		/** Real current instance; reacquire after HMR or restart. */
		require<T extends DevTypedPluginTarget>(target: T): DevPluginInstance<T>
	}
	readonly config: {
		/** Raw saved input and its effective runtime projection, without writing either. */
		inspect(target: DevPluginTarget): Promise<DevConfigInspection>
		status(): HostConfigState
		get(target: DevPluginTarget): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		validate(
			target: DevPluginTarget,
			change: HostConfigMutation,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		patch(
			target: DevPluginTarget,
			change: HostConfigMutation,
			options?: HostOperationOptions,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		/** Clears saved paths to restore inheritance; an empty list changes nothing. */
		reset(
			target: DevPluginTarget,
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
}
