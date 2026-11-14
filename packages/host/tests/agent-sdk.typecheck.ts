import type { PluginNodeAddress } from '@pluxel/core'
import type { Script, ScriptSdk } from '../src/agent'
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
const { config, status, fork } = dynamic
const { get, patch } = config
void status()
void patch({ set: { concurrency: 'unknown external input' } })
void fork('tenant-a').config.patch({ set: { concurrency: true } })
const dynamicResult = await get()
if (dynamicResult.isOk())
	expectTypeOf(dynamicResult.value.config.concurrency).toEqualTypeOf<unknown>()

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
	for (const entry of api.Result.unwrap(await api.plugins.list())) {
		const current = await api.plugin(entry.address).config.get()
		if (current.isErr()) {
			results.push(current.error)
			continue
		}
		results.push({
			node: entry.address,
			sources: current.value.sources,
			revision: current.value.managedRevision,
		})
	}
	return results
}) satisfies Script
