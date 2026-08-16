import type { PluginNodeAddressSnapshot } from '../plugins/runtime/identity'

export type PluxelContextLike = {
	name: string
	pluginInfo?: { nodeAddress?: PluginNodeAddressSnapshot } | undefined
	parent?: unknown
	caller?: unknown
}

export function findPluginNodeAddress(
	ctx: PluxelContextLike,
): PluginNodeAddressSnapshot | undefined {
	let current: PluxelContextLike | undefined = ctx
	while (current) {
		const address = current.pluginInfo?.nodeAddress
		if (address) return address
		current =
			(current.parent as PluxelContextLike | undefined) ??
			(current.caller as PluxelContextLike | undefined)
	}
	return undefined
}
