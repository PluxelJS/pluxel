import type { PluginConstructor, PluginNodeAddress, RootContext } from '@pluxel/core'
import type {
	HostPluginStatusSnapshot,
	HostPluginConfigResult,
	PluginApplyReportSnapshot,
	RuntimeUpdateSnapshot,
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
		get(target: DevPluginTarget): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		validate(
			target: DevPluginTarget,
			patch: Readonly<Record<string, unknown>>,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		patch(
			target: DevPluginTarget,
			patch: Readonly<Record<string, unknown>>,
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
		/** Omitted or empty keys resets every saved top-level field. */
		reset(
			target: DevPluginTarget,
			keys?: readonly string[],
		): Promise<HostPluginConfigResult<PluginApplyReportSnapshot>>
	}
}
