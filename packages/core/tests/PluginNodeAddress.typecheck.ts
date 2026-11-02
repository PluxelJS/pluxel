import {
	BasePlugin,
	type PluginConstructor,
	type PluginDefaultNodeAddress,
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
	type PluginToken,
} from '@pluxel/core'

declare const concrete: PluginConstructor
declare const token: PluginToken
declare const forkId: string | undefined

export const defaultNode: PluginDefaultNodeAddress = concrete.nodeAddress()
export const forkNode: PluginForkNodeAddress = concrete.nodeAddress('east')
export const maybeFork: PluginNodeAddress = concrete.nodeAddress(forkId)
export const definition: PluginDefinitionAddress = token.definitionAddress()

abstract class Capability extends BasePlugin {}
export const capability: PluginDefinitionAddress = Capability.definitionAddress()

// @ts-expect-error An omitted fork id describes a default node, never a fork.
export const invalidFork: PluginForkNodeAddress = concrete.nodeAddress()
// @ts-expect-error A named fork does not describe a default node.
export const invalidDefault: PluginDefaultNodeAddress = concrete.nodeAddress('east')
