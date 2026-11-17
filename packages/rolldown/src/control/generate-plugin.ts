import { pluginDefinitionIndexKey } from '@pluxel/core'
import * as contracts from './manifest'
import { generateControl } from './generate'
import { inspectPluginSource } from '../rolldown/plugins/pluginSemanticsPlugin'
import { extractConfigDeclarationFacts } from '../rolldown/plugins/configSourcePlugin'

/** Add Plugin source analysis to the shared control material generator. */
export function generatePluginControl(
	options: Omit<Parameters<typeof generateControl>[0], 'pluginAnalysis' | 'contracts'>,
) {
	return generateControl({
		...options,
		contracts: { ...contracts, pluginDefinitionIndexKey },
		pluginAnalysis: [{ inspectPluginSource }, { extractConfigDeclarationFacts }],
	})
}
