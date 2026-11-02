import type { PluginConstructor, PluginNodeAddress, RootContext } from '@pluxel/core'
import type {
	HostPluginStatusSnapshot,
	HostPluginConfigResult,
	PluginApplyReportSnapshot,
	RuntimeUpdateSnapshot,
	HostConfigState,
	HostStateConfigurationSnapshot,
	HostConfigSource,
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
	mode: 'memory' | 'writable' | 'readonly'
	readonly: boolean
	override: boolean
	externalReload: boolean
	saved: Readonly<Record<string, unknown>>
	declared: Readonly<Record<string, unknown>>
	effective: Readonly<Record<string, unknown>>
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
			patch: Readonly<Record<string, unknown>>,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		patch(
			target: DevPluginTarget,
			patch: Readonly<Record<string, unknown>>,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		/** Omitted keys resets all declared/saved fields; an empty list changes nothing. */
		reset(
			target: DevPluginTarget,
			keys?: readonly string[],
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
	}
	readonly state: {
		inspect(): Promise<HostStateConfigurationSnapshot>
	}
}
