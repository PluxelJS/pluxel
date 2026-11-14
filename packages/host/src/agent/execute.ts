import type { RootContext } from '@pluxel/core'
import { createScriptScope, type ScriptScope } from './sdk'
import type { Script, ScriptSdk } from './sdk-types'
import type { RunExecution } from './runtime'
import { snapshotJson } from './protocol'

/** Same-process execution uses Host implementations directly, without an RPC session. */
export async function executeHostScript(
	options: Readonly<{
		ctx: RootContext
		id: string
		input?: unknown
		script: Script
		extendSdk?(scope: ScriptScope): ScriptSdk
	}>,
	run: RunExecution,
): Promise<unknown> {
	const scope = createScriptScope({ ctx: options.ctx, signal: run.signal })
	let result: unknown
	let failure: unknown
	let failed = false
	try {
		run.revision('before', await scope.snapshot())
		run.signal.throwIfAborted()
		run.phase('execute')
		result = await options.script(
			options.extendSdk?.(scope) ?? scope.sdk,
			Object.freeze({ id: options.id, input: options.input, signal: run.signal }),
		)
	} catch (error) {
		failed = true
		failure = error
	}
	try {
		if (!failed) run.phase('cleanup')
		await scope.dispose()
	} catch (error) {
		run.cleanupFailure(error)
		if (!failed) {
			failed = true
			failure = error
		}
	}
	try {
		run.revision('after', await scope.snapshot())
	} catch (error) {
		if (!failed) {
			failed = true
			failure = error
		}
	}
	if (failed) throw failure
	// Validate before an async return can probe `then` on a now-closed business
	// view. Keep encoding after the scope has drained, and report its own phase.
	run.phase('encode')
	return snapshotJson(result)
}
