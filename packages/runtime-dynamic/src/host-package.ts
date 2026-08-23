import { existsSync } from 'node:fs'
import { dirname, parse, resolve } from 'node:path'
import { installedPackageJsonPath } from '@pluxel/runtime/internal'

/** Mirrors Node's ancestor `node_modules` lookup without consulting workspace-aware tool hooks. */
export function isPackageInstalledFrom(baseDir: string, packageName: string): boolean {
	let current = resolve(baseDir)
	const filesystemRoot = parse(current).root
	while (true) {
		const manifest = installedPackageJsonPath(current, packageName)
		if (manifest && existsSync(manifest)) return true
		if (current === filesystemRoot) return false
		const parent = dirname(current)
		if (parent === current) return false
		current = parent
	}
}
