import { query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import { PackageLoadIssueEntry, PackageInventoryEntry, PackageInventoryFilter } from './schema'
import { listLoadIssues, listPackageInventory } from './service'

/**
 * Package-manager GraphQL resolver - queries only.
 * Mutations are exposed through the route RPC handle.
 */
export function createPackageManagerResolver(pCtx: PlxContext) {
	return resolver({
		packageLoadIssues: query(v.array(PackageLoadIssueEntry)).resolve(() => listLoadIssues(pCtx)),
		packageInventory: query(v.array(PackageInventoryEntry))
			.input(PackageInventoryFilter)
			.resolve(({ includeUntracked }) => listPackageInventory(pCtx, { includeUntracked })),
	})
}
