import { expectTypeOf } from 'vitest'
import { parsePluginNodeAddress, type BasePlugin } from '@pluxel/core'
import type { CoreTestHost } from '@pluxel/core/internal/test'

declare class SearchIndex extends BasePlugin {
	find(): string
}

declare class SnapshotReader extends BasePlugin {
	read(): void
}

const primary = SearchIndex.nodeAddress()
const shard = SearchIndex.nodeAddress('shard')

export async function coreTestHostTypes(host: CoreTestHost): Promise<void> {
	const single = await host.add(primary)
	expectTypeOf(single).toEqualTypeOf<SearchIndex>()
	const tuple = await host.add([primary, shard, SnapshotReader.nodeAddress()])
	expectTypeOf(tuple).toEqualTypeOf<readonly [SearchIndex, SearchIndex, SnapshotReader]>()
	await host.commit((change) => change.add(primary))

	// @ts-expect-error Core test hosts select a source node address.
	await host.add(SearchIndex)
	// @ts-expect-error Portable identity does not provide implementation evidence.
	await host.add(parsePluginNodeAddress(primary))
	// @ts-expect-error The draft is confined to a synchronous callback.
	await host.commit(async (change) => change.add(primary))
	// @ts-expect-error Batch add does not accept per-node initialization through this overload.
	await host.add([primary, shard], { initialConfig: {} })
	await host.commit((change) =>
		change.dependencies.setDefault({
			requirement: SearchIndex,
			// @ts-expect-error A global default selects a provider definition.
			provider: shard,
		}),
	)
	// @ts-expect-error Replacement selects definitions.
	await host.replaceDefinition(shard, SearchIndex)
	// @ts-expect-error The author-side host does not expose root Context authority.
	void host.ctx
}
