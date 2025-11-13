import { existsSync } from 'node:fs'
import { readPackageJSON } from 'pkg-types'
import { resolve as r } from 'pathe'
import type { PackageJson } from 'pkg-types'

export async function safeReadManifest(dir: string): Promise<PackageJson | undefined> {
	try {
		return await readPackageJSON(dir)
	} catch {
		return undefined
	}
}

export function manifestPathFor(dir: string): string | undefined {
	const path = r(dir, 'package.json')
	return existsSync(path) ? path : undefined
}
