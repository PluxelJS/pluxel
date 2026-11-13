import type { PluginConstructor, PluginNodeAddress, RootContext } from '@pluxel/core'
import type { ScriptContext, ScriptSdk } from '@pluxel/host/agent'

/** Resolves an already declared node, including an already materialized fork. */
export type ProjectPluginTarget<P extends PluginConstructor = PluginConstructor> =
	| P
	| Readonly<{ plugin: P; forkId: string }>
export type ProjectPluginInstance<T extends ProjectPluginTarget> = T extends PluginConstructor
	? InstanceType<T>
	: T extends { plugin: infer P extends PluginConstructor }
		? InstanceType<P>
		: never

export interface ProjectSdk extends ScriptSdk {
	readonly dev: {
		/** Borrowed root. Reacquire handles after replacement; release resources created by the script. */
		readonly ctx: RootContext
		/** Checks the imported constructor against the current catalog before returning its address. */
		address(target: ProjectPluginTarget): PluginNodeAddress
		/** Returns the actual current instance. JavaScript objects already acquired cannot be revoked. */
		instance<T extends ProjectPluginTarget>(target: T): ProjectPluginInstance<T>
	}
}
export type ProjectScript = (sdk: ProjectSdk, run: ScriptContext) => unknown | Promise<unknown>
