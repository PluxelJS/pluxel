import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'pathe'

import type { MaterializeProfiledFileOptions, ResolvedProfiledPath } from '@pluxel/runtime/internal'
import { resolveProfiledPath } from '@pluxel/runtime/internal'
import type { FsServiceNodeBackendFs } from '@pluxel/runtime/services'

type MaterializeFs = Pick<FsServiceNodeBackendFs, 'existsSync'> & {
	promises: Pick<FsServiceNodeBackendFs['promises'], 'copyFile' | 'mkdir'>
}

const nodeMaterializeFs: MaterializeFs = {
	existsSync,
	promises: {
		copyFile,
		mkdir,
	},
}

export async function materializeProfiledFile(
	basePath: string,
	options: MaterializeProfiledFileOptions = {},
	fsOps: MaterializeFs = nodeMaterializeFs,
): Promise<ResolvedProfiledPath> {
	const resolved = resolveProfiledPath(basePath, options.profile)
	const seedFile = options.seedFile
	await fsOps.promises.mkdir(dirname(resolved.path), { recursive: true })
	if (seedFile === false || !seedFile || fsOps.existsSync(resolved.path)) return resolved
	if (fsOps.existsSync(seedFile)) {
		await fsOps.promises.copyFile(seedFile, resolved.path)
	}
	return resolved
}
