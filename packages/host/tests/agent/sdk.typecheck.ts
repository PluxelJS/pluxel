import type { PluginNodeAddress } from '@pluxel/core'
import type { Script, ScriptSdk } from '../../src/agent'
import { expectTypeOf } from 'vitest'

declare const sdk: ScriptSdk
declare const node: PluginNodeAddress

expectTypeOf<keyof ScriptSdk['plugins']>().toEqualTypeOf<'list'>()
// @ts-expect-error Configuration is available only on a selected Plugin reference.
void sdk.config
// @ts-expect-error Discovered addresses have no statically known business instance.
void sdk.plugin(node).instance
const { plugin } = sdk
const dynamic = plugin(node)
const { config, status } = dynamic
const { get, patch } = config
void status()
void patch({ set: { concurrency: 'unknown external input' } })
// @ts-expect-error Node references have no second fork selector.
void dynamic.fork
const dynamicResult = await get()
expectTypeOf(dynamicResult.config.concurrency).toEqualTypeOf<unknown>()

void sdk
	.plugin(node)
	.config.patch({ set: { concurrency: 2 } }, { expectedManagedRevision: 'revision' })
// @ts-expect-error Stable node addresses, not Plugin names or constructors.
void sdk.plugin('Counter').start()
// @ts-expect-error Version conditions use the Host managed revision contract.
void sdk.plugin(node).config.patch({ set: {} }, { revision: 'old' })
// @ts-expect-error A finite log deadline is required.
void sdk.logs.wait({ rootId: '', streamId: '', bootId: '', epoch: 1, nextSeq: '0' }, {})

export default (async (api, run) => {
	run.signal.throwIfAborted()
	const results = []
	const plugins = await api.plugins.list()
	for (const entry of plugins.nodes) {
		const current = await api.plugin(entry.address).config.get()
		results.push({
			node: entry.address,
			sources: current.sources,
			revision: current.managedRevision,
		})
	}
	return results
}) satisfies Script
