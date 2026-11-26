import type { PGlite, PGliteOptions } from '@electric-sql/pglite'
import type { HostService } from '@pluxel/host'
import { installPg } from './install'

/** Native PGlite configuration creates a Host-owned client on first use; an existing client is borrowed. */
export function pglite(options: PGliteOptions | PGlite = {}): HostService {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[pluxel/pg] pglite requires PGliteOptions or PGlite')
	return installPg(async () => {
		const { createPgliteDatabaseAdapter } = await import('./adapters/pglite')
		return createPgliteDatabaseAdapter(options)
	})
}
