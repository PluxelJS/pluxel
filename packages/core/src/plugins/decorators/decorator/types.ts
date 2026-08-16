import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { PluginConstructor, PluginIdentifier } from '../../types'
import type {
	PluginDefinitionAddressSnapshot,
	PluginDefinitionSlot,
	PluginNodeAddressSnapshot,
	PluginNodeSlot,
} from '../../runtime/identity'

export interface PluginOptions {
	readonly displayName?: string
	readonly startTimeoutMs?: number
}

export interface PluginDeclarationInfo {
	readonly class: PluginConstructor
	readonly definition: PluginDefinitionAddressSnapshot
	readonly rootExportName: string
	readonly displayName: string
	readonly startTimeoutMs?: number
	readonly provider?: PluginDefinitionAddressSnapshot
	readonly config?: Readonly<{
		fieldName: string
		schema: StandardSchemaV1
		source?: string
	}>
}

/** Runtime generation identity installed on each isolated Plugin Context. */
export interface PluginInfo extends PluginDeclarationInfo {
	readonly definitionSlot: PluginDefinitionSlot
	readonly nodeSlot: PluginNodeSlot
	readonly nodeAddress: PluginNodeAddressSnapshot
}

export interface PluginMarker {
	readonly options: PluginOptions
	readonly providerClass?: PluginIdentifier
}
