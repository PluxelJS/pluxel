import type { D1Database } from '@cloudflare/workers-types'
import type { HostService } from '@pluxel/host/application'
import { verifyD1History } from './d1-state'
import { installSqlite } from './install'

/** Borrow one deployed D1 database per canonical plugin or fork reference. */
export function d1(bindings: Readonly<Record<string, D1Database>>): HostService {
	const databases = new Map(Object.entries(bindings))
	return installSqlite(async (owner, definition, artifact) => {
		const binding = databases.get(owner)
		if (!binding)
			throw new Error(`[pluxel/sqlite/d1] no D1 binding configured for owner "${owner}"`)
		let count: number
		try {
			count = await verifyD1History(binding, owner, artifact)
		} catch (cause) {
			throw new Error(
				`[pluxel/sqlite/d1] could not verify the D1 binding for "${owner}": ${cause instanceof Error ? cause.message : String(cause)}. Check the deployment and its migrateD1 result.`,
				{ cause },
			)
		}
		if (count !== artifact.migrations.length) {
			throw new Error(
				`[pluxel/sqlite/d1] owner "${owner}" has ${count} of ${artifact.migrations.length} migrations. Run migrateD1 for this release before starting the plugin.`,
			)
		}
		const { drizzle } = await import('drizzle-orm/d1')
		return {
			db: drizzle(binding, { schema: definition.schema }),
			supportsInteractiveTransactions: false,
		}
	})
}
