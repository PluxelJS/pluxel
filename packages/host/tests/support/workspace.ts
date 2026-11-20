import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const hostPackage = new URL('../../', import.meta.url)

type Package = 'core' | 'host'

export async function linkPluxelPackages(root: string, packages: readonly Package[]) {
	const scope = join(root, 'node_modules/@pluxel')
	await mkdir(scope, { recursive: true })
	for (const name of packages) {
		await symlink(fileURLToPath(new URL(`../${name}`, hostPackage)), join(scope, name), 'dir')
	}
}

export async function createWorkspace(prefix: string, packages: readonly Package[] = []) {
	const temporary = new URL('.tmp/', hostPackage)
	await mkdir(temporary, { recursive: true })
	const root = await mkdtemp(fileURLToPath(new URL(`${prefix}-`, temporary)))
	try {
		if (packages.length > 0) await linkPluxelPackages(root, packages)
	} catch (error) {
		await rm(root, { recursive: true, force: true })
		throw error
	}
	return {
		root,
		[Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
	}
}
