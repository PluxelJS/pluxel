import type { PluginNodeAddress } from '@pluxel/core'
import type { Script, ScriptSdk } from '../src/agent'

declare const sdk: ScriptSdk
declare const node: PluginNodeAddress

void sdk.config.patch(node, { set: { concurrency: 2 } }, { expectedManagedRevision: 'revision' })
// @ts-expect-error Stable node addresses, not Plugin names or constructors.
void sdk.plugins.start('Counter')
// @ts-expect-error Version conditions use the Host managed revision contract.
void sdk.config.patch(node, { set: {} }, { revision: 'old' })
// @ts-expect-error A finite log deadline is required.
void sdk.logs.wait({ rootId: '', streamId: '', bootId: '', epoch: 1, nextSeq: '0' }, {})

export default (async (api, run) => {
	run.signal.throwIfAborted()
	const results = []
	for (const plugin of await api.plugins.list()) {
		const current = await api.config.get(plugin.address)
		if (!current.ok) {
			results.push(current)
			continue
		}
		results.push({
			node: plugin.address,
			sources: current.sources,
			revision: current.managedRevision,
		})
	}
	return results
}) satisfies Script
