import { field, query, resolver, type Resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/core'
import * as v from 'valibot'

import {
	PackageInventoryEntry,
	PackageInventoryFilter,
	PackageLoadIssueEntry,
	PackageManager,
} from './schema'
import {
	listLoadIssues,
	listPackageInventory,
	readLoadIssue,
	readPackageInventoryEntry,
} from './service'

/**
 * Package-manager GraphQL resolver - queries only.
 * Mutations are exposed through the packageManager route feature.
 */
export function createPackageManagerResolver(pCtx: PlxContext): Resolver[] {
	const queries = resolver({
		packageManager: query(PackageManager).resolve(() => ({
			__typename: 'PackageManager' as const,
		})),
	})

	const packageManagerFields = resolver.of(PackageManager, {
		loadIssue: field(PackageLoadIssueEntry)
			.input({ id: v.string() })
			.resolve((_manager, { id }) => readLoadIssue(pCtx, id)),
		loadIssues: field(v.array(PackageLoadIssueEntry)).resolve(() => listLoadIssues(pCtx)),
		inventoryEntry: field(PackageInventoryEntry)
			.input({ id: v.string(), includeUntracked: v.nullish(v.boolean()) })
			.resolve((_manager, { id, includeUntracked }) =>
				readPackageInventoryEntry(pCtx, id, { includeUntracked }),
			),
		inventory: field(v.array(PackageInventoryEntry))
			.input(PackageInventoryFilter)
			.resolve((_manager, { includeUntracked }) =>
				listPackageInventory(pCtx, { includeUntracked }),
			),
	})

	return [queries, packageManagerFields]
}
