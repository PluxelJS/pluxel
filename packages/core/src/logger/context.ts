import type { PluginNodeAddress } from '../plugins/runtime/identity'

export type PluxelContextLike = {
	name: string
	pluginInfo?: { nodeAddress?: PluginNodeAddress; displayName?: string } | undefined
	parent?: unknown
	caller?: unknown
}

export type PluginLogContext = Readonly<{
	nodeAddress: PluginNodeAddress
	displayName?: string
}>

export function findPluginLogContext(ctx: PluxelContextLike): PluginLogContext | undefined {
	let current: PluxelContextLike | undefined = ctx
	while (current) {
		const nodeAddress = current.pluginInfo?.nodeAddress
		if (nodeAddress) {
			return {
				nodeAddress,
				displayName: current.pluginInfo?.displayName,
			}
		}
		current =
			(current.parent as PluxelContextLike | undefined) ??
			(current.caller as PluxelContextLike | undefined)
	}
	return undefined
}

export function findPluginNodeAddress(ctx: PluxelContextLike): PluginNodeAddress | undefined {
	return findPluginLogContext(ctx)?.nodeAddress
}
