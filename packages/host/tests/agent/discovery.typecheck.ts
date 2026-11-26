import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { ScriptSdk, ScriptPluginListOptions, ScriptPluginListError } from '../../src/agent'
import { expectTypeOf } from 'vitest'

declare const sdk: ScriptSdk
declare const definition: PluginDefinitionAddress
declare const node: PluginNodeAddress

const query = { definition, limit: 2 } satisfies ScriptPluginListOptions
const page = await sdk.plugins.list(query)
expectTypeOf(page.nextCursor).toEqualTypeOf<string | null>()
const found = page.nodes[0]
if (found) {
	void sdk.plugin(found.address).status()
	// @ts-expect-error Discovery returns identity, not business-call evidence.
	void sdk.plugin(found.address).instance()
}
expectTypeOf<ScriptPluginListError['code']>().toEqualTypeOf<
	'scope_closed' | 'cancelled' | 'borrowed_generation_conflict' | 'cursor_stale'
>()
// @ts-expect-error Definition filtering takes the complete definition address, not a display name.
void sdk.plugins.list({ definition: 'Provider' })
// @ts-expect-error A node is selected directly; discovery filters definitions and includes their forks.
void sdk.plugins.list({ definition: node })
// @ts-expect-error Runtime and managed revisions are not query cursors.
void sdk.plugins.list({ cursor: 1 })
