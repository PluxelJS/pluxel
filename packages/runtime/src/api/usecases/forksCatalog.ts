import type {
	Context,
	PluginDefinitionAddressSnapshot,
	PluginNodeAddressSnapshot,
} from '@pluxel/core'
import { samePluginDefinitionAddress } from '../../services/RuntimeStateHelpers'

export function addForkToCatalog(
	ctx: Context,
	definition: PluginDefinitionAddressSnapshot,
	forkId: string,
): void {
	const id = String(forkId).trim()
	if (!id) throw new Error('forkId is required')
	ctx.runtimeState.update((draft) => {
		const index = draft.forks.findIndex((entry) =>
			samePluginDefinitionAddress(entry.definition, definition),
		)
		const previous = index < 0 ? undefined : draft.forks[index]
		if (previous?.forkIds.includes(id)) return
		const next = { definition, forkIds: [...(previous?.forkIds ?? []), id] }
		if (index < 0) draft.forks.push(next)
		else draft.forks[index] = next
	})
}

export function maybeAddForkToCatalog(ctx: Context, node: PluginNodeAddressSnapshot): void {
	if (node.instance === 'fork') addForkToCatalog(ctx, node.definition, node.forkId)
}
