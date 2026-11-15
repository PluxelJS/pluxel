import type { PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'
import type { ScriptSdk, ScriptPluginListOptions } from '../src/agent'
import { expectTypeOf } from 'vitest'

declare const sdk: ScriptSdk
declare const definition: PluginDefinitionAddress
declare const node: PluginNodeAddress

const query = { definition, limit: 2 } satisfies ScriptPluginListOptions
const page = await sdk.plugins.list(query)
if (page.isOk()) {
	expectTypeOf(page.value.nextCursor).toEqualTypeOf<string | null>()
	const found = page.value.nodes[0]
	if (found) {
		void sdk.plugin(found.address).status()
		// @ts-expect-error Discovery returns identity, not business-call evidence.
		void sdk.plugin(found.address).instance()
	}
} else {
	expectTypeOf(page.error.code).toEqualTypeOf<
		'scope_closed' | 'cancelled' | 'borrowed_generation_conflict' | 'cursor_stale'
	>()
}
// @ts-expect-error Definition filtering takes the complete definition address, not a display name.
void sdk.plugins.list({ definition: 'Provider' })
// @ts-expect-error A node is selected directly; discovery filters definitions and includes their forks.
void sdk.plugins.list({ definition: node })
// @ts-expect-error Runtime and managed revisions are not query cursors.
void sdk.plugins.list({ cursor: 1 })
