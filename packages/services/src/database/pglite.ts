import type { DatabaseBackend } from './service'
export type PgliteOptions = Readonly<{ dataDir: string }>
/** Select only the PGlite backend. Loading and connection creation happen on first use. */
export function pglite(options: PgliteOptions): DatabaseBackend {
	if (!options || typeof options.dataDir !== 'string' || !options.dataDir.trim())
		throw new TypeError('[pluxel/database] pglite requires dataDir')
	const snapshot = Object.freeze({ ...options })
	return async () => {
		const { createPgliteDatabaseAdapter } = await import('#pluxel/database-driver/pglite')
		return createPgliteDatabaseAdapter(snapshot)
	}
}
