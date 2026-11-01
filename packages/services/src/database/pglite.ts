import type { PGlite, PGliteOptions } from '@electric-sql/pglite'
import type { DatabaseBackend } from './service'

/** Native PGlite configuration creates a Host-owned client on first use; an existing client is borrowed. */
export function pglite(options: PGliteOptions | PGlite = {}): DatabaseBackend {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[pluxel/database] pglite requires PGliteOptions or PGlite')
	return async () => {
		const { createPgliteDatabaseAdapter } = await import('#pluxel/database-driver/pglite')
		return createPgliteDatabaseAdapter(options)
	}
}
