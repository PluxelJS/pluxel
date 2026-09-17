import type { PostgresOptions } from '@pluxel/services/database/postgres'
/** Runtime composition retains its default PGlite location policy. */
export type DatabaseConfig =
	| false
	| (PostgresOptions & { readonly driver: 'postgres' })
	| Readonly<{ driver: 'pglite'; dataDir?: string }>
