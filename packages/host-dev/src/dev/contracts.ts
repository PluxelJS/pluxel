import type { PluginConstructor, PluginNodeAddress, RootContext } from '@pluxel/core'
import type {
	HostPluginStatusSnapshot,
	HostPluginConfigResult,
	PluginApplyReport,
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
export type DevRunContext = Readonly<{ id: string; input: unknown; signal: AbortSignal }>
export type DevScript = (dev: DevConsole, run: DevRunContext) => unknown | Promise<unknown>

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
	/** Borrowed current root, valid only during this run. Acquired objects are not revocable proxies. */
	readonly ctx: RootContext
	readonly plugins: {
		list(): Promise<readonly HostPluginStatusSnapshot[]>
		status(target: DevPluginTarget): Promise<HostPluginStatusSnapshot | null>
		isRunning(target: DevPluginTarget): boolean
		start(target: DevPluginTarget): Promise<PluginApplyReport>
		stop(target: DevPluginTarget): Promise<PluginApplyReport>
		restart(target: DevPluginTarget): Promise<PluginApplyReport>
		/** Real current instance; reacquire after HMR or restart. */
		require<T extends DevTypedPluginTarget>(target: T): DevPluginInstance<T>
	}
	readonly config: {
		get(target: DevPluginTarget): Promise<HostPluginConfigResult>
		validate(
			target: DevPluginTarget,
			patch: Readonly<Record<string, unknown>>,
		): Promise<HostPluginConfigResult>
		patch(
			target: DevPluginTarget,
			patch: Readonly<Record<string, unknown>>,
		): Promise<HostPluginConfigResult>
		/** Omitted or empty keys resets every saved top-level field. */
		reset(target: DevPluginTarget, keys?: readonly string[]): Promise<HostPluginConfigResult>
	}
}
