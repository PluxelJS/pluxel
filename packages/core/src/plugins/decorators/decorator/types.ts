import type { PluginConstructor, PluginIdentifier } from '../../types'
import type { PluginConfigDefinition } from '../../runtime/definition'
import type {
	PluginDefinitionAddress,
	PluginDefinitionSlot,
	PluginNodeAddress,
	PluginNodeSlot,
} from '../../runtime/identity'

export interface PluginOptions {
	readonly displayName?: string
	readonly startTimeoutMs?: number
}

export interface PluginDeclarationInfo {
	readonly class: PluginConstructor
	readonly definition: PluginDefinitionAddress
	readonly rootExportName: string
	readonly displayName: string
	readonly startTimeoutMs?: number
	readonly provider?: PluginDefinitionAddress
	readonly config?: PluginConfigDefinition
}

/** Runtime generation identity installed on each isolated Plugin Context. */
export interface PluginInfo extends PluginDeclarationInfo {
	readonly definitionSlot: PluginDefinitionSlot
	readonly nodeSlot: PluginNodeSlot
	readonly nodeAddress: PluginNodeAddress
}

export interface PluginMarker {
	readonly options: PluginOptions
	readonly providerClass?: PluginIdentifier
}
