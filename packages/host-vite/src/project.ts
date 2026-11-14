import type { RootContext } from '@pluxel/core'
import type { ScriptContext, ScriptSdk } from '@pluxel/host/agent'

export interface ProjectSdk extends ScriptSdk {
	readonly dev: {
		/** Borrowed root. Reacquire handles after replacement; release resources created by the script. */
		readonly ctx: RootContext
	}
}
export type ProjectScript = (sdk: ProjectSdk, run: ScriptContext) => unknown | Promise<unknown>
