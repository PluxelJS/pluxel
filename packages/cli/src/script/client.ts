import {
	createScriptControlClient,
	type ScriptControlClient,
	type ScriptTargetDescription,
} from '@pluxel/host/internal/agent/transport'
import { ScriptExecutionError } from '@pluxel/host/internal/agent/runtime'
import { connectRuntimeTarget, type Credentials } from './session'
export { readScriptCredentials } from './session'

export interface ScriptConnection extends Disposable {
	readonly control: ScriptControlClient
	readonly description: ScriptTargetDescription
}

/** Execution requires its separate grant; read-only Management does not. */
export async function connectScriptTarget(
	options: Readonly<{ endpoint: string; credentials?: Credentials; instanceId?: string }>,
): Promise<ScriptConnection> {
	const connection = await connectRuntimeTarget(options)
	let control: ScriptControlClient | undefined
	try {
		if (!connection.execution)
			throw new ScriptExecutionError(
				'execution_disabled',
				'This Host has not enabled trusted script execution',
			)
		control = createScriptControlClient(connection.execution.dup(), {
			instanceId: options.instanceId,
		})
		const description = await control.describe()
		return {
			control,
			description,
			[Symbol.dispose]() {
				try {
					control?.[Symbol.dispose]()
				} finally {
					connection[Symbol.dispose]()
				}
			},
		}
	} catch (error) {
		try {
			control?.[Symbol.dispose]()
		} finally {
			connection[Symbol.dispose]()
		}
		throw error
	}
}
