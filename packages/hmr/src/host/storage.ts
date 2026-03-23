import { existsSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'pathe'

import type { MaterializeProfiledFileOptions, ResolvedProfiledPath } from '@pluxel/runtime/internal'
import { resolveProfiledPath } from '@pluxel/runtime/internal'

export async function materializeProfiledFile(
	basePath: string,
	options: MaterializeProfiledFileOptions = {},
): Promise<ResolvedProfiledPath> {
	const resolved = resolveProfiledPath(basePath, options.profile)
	await mkdir(dirname(resolved.path), { recursive: true })
	if (options.seedFile !== false && options.seedFile && !existsSync(resolved.path)) {
		const seedFile = resolve(options.seedFile)
		if (existsSync(seedFile)) await copyFile(seedFile, resolved.path)
	}
	return resolved
}
