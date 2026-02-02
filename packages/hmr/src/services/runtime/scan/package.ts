import { existsSync } from 'node:fs'
import { readPackageJSON } from 'pkg-types'
import { resolve as r } from 'pathe'
import type { PackageJson } from 'pkg-types'

export async function safeReadManifest(dir: string): Promise<PackageJson | undefined> {
	const manifestPath = r(dir, 'package.json')
	if (!existsSync(manifestPath)) return undefined
	try {
		return await readPackageJSON(manifestPath)
	} catch {
		return undefined
	}
}

export function manifestPathFor(dir: string): string | undefined {
	const path = r(dir, 'package.json')
	return existsSync(path) ? path : undefined
}
