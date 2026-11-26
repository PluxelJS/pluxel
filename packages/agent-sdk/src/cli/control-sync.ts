import { parsePluginDefinitionReference } from '@pluxel/core'
import { ScriptExecutionError } from '@pluxel/host/internal/agent/runtime'
import { parseControlSyncSelection, type ControlSyncSelection } from '../client/materials'

/** CLI references are the text representation of the client's standard definition addresses. */
export function parseControlSyncArgs(
	values: Readonly<{ 'package-name'?: string; definition?: string }>,
): ControlSyncSelection {
	let definition
	try {
		if (values.definition !== undefined)
			definition = parsePluginDefinitionReference(values.definition)
	} catch (error) {
		throw new ScriptExecutionError(
			'invalid_input',
			error instanceof Error ? error.message : 'Invalid canonical definition reference',
		)
	}
	return parseControlSyncSelection({ packageName: values['package-name'], definition })
}
