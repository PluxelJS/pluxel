import type { PluginConstructor, PluginNodeAddress, RootContext } from '@pluxel/core'
import type { Result } from '@pluxel/core/better-result'
import type {
	ScriptContext,
	ScriptInstanceError,
	ScriptPlugin,
	ScriptSdk,
} from '@pluxel/host/agent'

/** A constructor selects the exact loaded implementation, including after HMR. */
export type ProjectPlugin<P extends PluginConstructor> = Omit<
	ScriptPlugin<PluginNodeAddress>,
	'config' | 'fork'
> & {
	readonly fork: (forkId: string) => ProjectPlugin<P>
	readonly instance: () => Promise<Result<InstanceType<P>, ScriptInstanceError>>
}

export interface ProjectSdk extends Omit<ScriptSdk, 'plugin'> {
	readonly plugin: ScriptSdk['plugin'] &
		(<const P extends PluginConstructor>(target: P) => ProjectPlugin<P>)
	readonly dev: {
		/** Borrowed root. Reacquire handles after replacement; release resources created by the script. */
		readonly ctx: RootContext
	}
}
export type ProjectScript = (sdk: ProjectSdk, run: ScriptContext) => unknown | Promise<unknown>
