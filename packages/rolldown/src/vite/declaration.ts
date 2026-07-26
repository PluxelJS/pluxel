import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'pathe'

export type PluginArtifactTarget = 'workbench' | 'node'

/** Stable declaration identity shared by production lowering and development compilation. */
export function resolvePluginArtifactKey(
	target: PluginArtifactTarget,
	root: string,
	declarationFile: string,
	entryPath: string,
): string {
	const prefix = target === 'node' ? 'node' : 'artifact'
	const length = target === 'node' ? 16 : 12
	return `${prefix}-${createHash('sha256')
		.update(`${canonicalDeclarationModuleId(root, declarationFile)}\0${entryPath}`)
		.digest('hex')
		.slice(0, length)}`
}

export function resolveNodeModuleBuildSignature(input: { minify?: boolean }): string {
	return ['node-module-builder:2', `minify:${input.minify === false ? 'false' : 'true'}`].join('\n')
}

function canonicalDeclarationModuleId(root: string, id: string): string {
	let current = dirname(id)
	for (let depth = 0; depth < 16; depth += 1) {
		const packageJson = resolve(current, 'package.json')
		if (existsSync(packageJson)) {
			try {
				const metadata = JSON.parse(readFileSync(packageJson, 'utf8')) as {
					name?: unknown
					version?: unknown
				}
				const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
				const version = typeof metadata.version === 'string' ? metadata.version.trim() : ''
				if (name && version) return `${name}@${version}:${relative(current, id)}`
			} catch {
				// Invalid package metadata is reported by the package build itself.
			}
			break
		}
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	return `application:${relative(resolve(root), id)}`
}
