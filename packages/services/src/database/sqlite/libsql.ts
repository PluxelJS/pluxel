import type { HostService } from '@pluxel/host/application'
import { resolve } from 'node:path'
import { installSqlite } from './install'

/** Open a local SQLite file for each plugin owner and migration lineage on first use. */
export function libsql(options: { directory: string }): HostService {
	if (
		typeof options?.directory !== 'string' ||
		!options.directory.trim() ||
		/^[a-z][a-z0-9+.-]*:\/\//i.test(options.directory)
	) {
		throw new TypeError('[pluxel/sqlite] libsql requires a local directory path')
	}
	const directory = resolve(options.directory)
	return installSqlite(async (ownerId, definition, artifact) => {
		const { openLocalDatabase } = await import('./libsql-client')
		return openLocalDatabase(directory, ownerId, definition.schema, artifact)
	})
}
