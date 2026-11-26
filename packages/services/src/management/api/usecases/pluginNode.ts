import type { PluginNodeAddress } from '@pluxel/core'
import {
	listForkIds,
	pluginCatalogEntry,
	type HostPluginGraphCommittedView,
} from '@pluxel/host/internal'

export class PluginNodeUnavailableError extends Error {
	constructor() {
		super('Plugin node is unavailable in the committed runtime graph policy')
		this.name = 'PluginNodeUnavailableError'
	}
}

export function requireAvailablePluginNode(
	view: HostPluginGraphCommittedView,
	address: PluginNodeAddress,
) {
	const entry = pluginCatalogEntry(view.catalog, address.definition)
	if (!entry) throw new PluginNodeUnavailableError()
	if (
		address.variant === 'fork' &&
		(!entry.candidate.declaration.forkable ||
			!listForkIds(view.runtimeState.state, address.definition).includes(address.forkId))
	) {
		throw new PluginNodeUnavailableError()
	}
	return entry.candidate
}
