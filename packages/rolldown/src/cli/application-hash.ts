import { createHash } from 'node:crypto'
import type { OutputBundle } from 'rolldown'

/** Deterministic compiled application identity shared by both delivery formats. */
export function applicationCatalogHash(bundle: OutputBundle): string {
	return createHash('sha256')
		.update(
			Object.values(bundle)
				.filter((item) => item.type === 'chunk')
				.sort((a, b) => a.fileName.localeCompare(b.fileName))
				.map((item) => `${item.fileName}\0${item.code}`)
				.join('\0'),
		)
		.digest('hex')
}
