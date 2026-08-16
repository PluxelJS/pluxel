import type { PluginConstructor, PluginIdentifier } from '../../types'
import {
	clonePluginDefinitionFacts,
	getPluginConfigDefinition,
	getPluginDefinitionFacts,
	hasPluginDefinitionFacts,
} from '../../runtime/definition'
import type { PluginSlotRegistry } from '../../runtime/identity'
import { getForkId } from '../../runtime/fork-identity'
import { clonePluginMarker, getPluginMarker } from './decorators'
import type { PluginDeclarationInfo, PluginInfo } from './types'

export function checkPluginDecorator(ctor: Function): boolean {
	return getPluginMarker(ctor) !== undefined
}

export function getPluginDeclaration(ctor: PluginConstructor): PluginDeclarationInfo {
	const marker = getPluginMarker(ctor)
	if (!marker) throw new Error('[pluxel/core] Plugin constructor is missing @Plugin')
	const facts = getPluginDefinitionFacts(ctor)
	if (facts.kind !== 'plugin') {
		throw new Error(
			'[pluxel/core] A runtime Plugin constructor must have concrete definition facts',
		)
	}
	const config = getPluginConfigDefinition(ctor)
	return Object.freeze({
		class: ctor,
		definition: facts.definition,
		rootExportName: facts.definition.exportName,
		displayName: marker.options.displayName ?? facts.definition.exportName,
		...(marker.options.startTimeoutMs === undefined
			? {}
			: { startTimeoutMs: marker.options.startTimeoutMs }),
		...(facts.provides === undefined ? {} : { provider: facts.provides }),
		...(config === undefined ? {} : { config }),
	})
}

export function createPluginInfo(ctor: PluginConstructor, slots: PluginSlotRegistry): PluginInfo {
	const declaration = getPluginDeclaration(ctor)
	const definitionSlot = slots.internDefinition(declaration.definition)
	const forkId = getForkId(ctor)
	const nodeSlot = forkId
		? slots.forkNode(definitionSlot, forkId)
		: slots.defaultNode(definitionSlot)
	return Object.freeze({
		...declaration,
		definitionSlot,
		nodeSlot,
		nodeAddress: slots.nodeAddress(nodeSlot),
	})
}

/** Declaration-only metadata. Runtime code should use Context.pluginInfo. */
export const getPluginInfo = getPluginDeclaration

export function getBaseClass(target: PluginIdentifier): PluginIdentifier | null {
	return getPluginMarker(target)?.providerClass ?? null
}

export function clonePluginDefinition(from: PluginConstructor, to: PluginConstructor): void {
	clonePluginMarker(from, to)
	clonePluginDefinitionFacts(from, to)
}

export { getPluginDefinitionFacts, hasPluginDefinitionFacts }
