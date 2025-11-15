import { writeFile } from 'node:fs/promises'
import { mutation, resolver } from '@gqloom/core'
import type { Context as PlxContext } from '@pluxel/hmr'
import { resolve } from 'pathe'

import { BuildSnapshotResult } from './schema'

export function createSnapshotResolver(pCtx: PlxContext) {
	return resolver({
		buildSnapshot: mutation(BuildSnapshotResult)
			.input({})
			.resolve(async () => {
				try {
					const content = pCtx.loader.buildSnapshot()
					const path = resolve(process.cwd(), 'snapshot.ts')
					await writeFile(path, content, 'utf8')
					return { __typename: 'BuildSnapshotResult' as const, ok: true, path }
				} catch (error) {
					return {
						__typename: 'BuildSnapshotResult' as const,
						ok: false,
						path: null,
						error: (error as Error)?.message ?? 'Unknown error',
					}
				}
			}),
	})
}
