import { query, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import {
	PackageLoadIssueEntry,
	PackageInventoryEntry,
	PackageInventoryFilter,
} from './schema'
import {
	listPackageInventory,
	listLoadIssues,
} from './service'

/**
 * Market GraphQL resolver - queries only
 * All mutations have been migrated to RPC (see MarketHandle.ts)
 */
export function createMarketResolver(pCtx: PlxContext) {
	return resolver({
		packageLoadIssues: query(v.array(PackageLoadIssueEntry)).resolve(() => listLoadIssues(pCtx)),
		packageInventory: query(v.array(PackageInventoryEntry))
			.input(PackageInventoryFilter)
			.resolve(({ includeUntracked }) => listPackageInventory(pCtx, { includeUntracked })),
	})
}
