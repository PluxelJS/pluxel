import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'

import { dirname, relative, resolve } from 'pathe'

import { repoRoot } from './_runtime-dist.mjs'

const linkSpecs = [
	{
		link: resolve(repoRoot, 'node_modules/@pluxel/runtime'),
		target: resolve(repoRoot, 'packages/runtime'),
	},
	{
		link: resolve(repoRoot, 'node_modules/@pluxel/hmr'),
		target: resolve(repoRoot, 'packages/hmr'),
	},
]

async function ensureSymlink(linkPath, targetPath) {
	const linkDir = dirname(linkPath)
	await mkdir(linkDir, { recursive: true })
	const relativeTarget = relative(linkDir, targetPath)

	try {
		const stat = await lstat(linkPath)
		if (!stat.isSymbolicLink()) {
			await rm(linkPath, { recursive: true, force: true })
		} else {
			const current = await readlink(linkPath)
			if (resolve(linkDir, current) === targetPath) return
			await rm(linkPath, { recursive: true, force: true })
		}
	} catch {}

	await symlink(relativeTarget, linkPath, 'dir')
}

for (const spec of linkSpecs) {
	await ensureSymlink(spec.link, spec.target)
}
