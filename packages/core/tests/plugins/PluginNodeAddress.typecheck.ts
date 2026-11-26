import {
	BasePlugin,
	type PluginConstructor,
	type PluginDefaultNodeAddress,
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
	type PluginToken,
	type PluginInstanceNodeAddress,
} from '@pluxel/core'

declare const concrete: PluginConstructor
declare const token: PluginToken
declare const forkId: string | undefined

export const defaultNode: PluginDefaultNodeAddress = concrete.nodeAddress()
export const forkNode: PluginForkNodeAddress = concrete.nodeAddress('east')
export const maybeFork: PluginNodeAddress = concrete.nodeAddress(forkId)
export const definition: PluginDefinitionAddress = token.address()

class Concrete extends BasePlugin {
	readonly count = 1
	increment(by: number): number {
		return this.count + by
	}
}
export const typedDefault: PluginInstanceNodeAddress<Concrete, PluginDefaultNodeAddress> =
	Concrete.nodeAddress()
export const typedFork: PluginInstanceNodeAddress<Concrete, PluginForkNodeAddress> =
	Concrete.nodeAddress('east')
export const typedMaybeFork: PluginInstanceNodeAddress<Concrete> = Concrete.nodeAddress(forkId)
// @ts-expect-error An address does not retain a different Plugin's instance contract.
export const wrongInstance: PluginInstanceNodeAddress<{ other(): void }> = Concrete.nodeAddress()

abstract class Capability extends BasePlugin {}
export const capability: PluginDefinitionAddress = Capability.address()

// @ts-expect-error An omitted fork id describes a default node, never a fork.
export const invalidFork: PluginForkNodeAddress = concrete.nodeAddress()
// @ts-expect-error A named fork does not describe a default node.
export const invalidDefault: PluginDefaultNodeAddress = concrete.nodeAddress('east')
