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

export function resolveNodeModuleBuildSignature(input: {
	vite?: unknown
	cacheKey?: string
	minify?: boolean
}): string {
	return [
		'node-module-builder:1',
		`minify:${input.minify === false ? 'false' : 'true'}`,
		input.cacheKey?.trim() ? `cacheKey:${input.cacheKey.trim()}` : '',
		input.vite ? `vite:${stableJsonish(input.vite)}` : '',
	]
		.filter(Boolean)
		.join('\n')
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

function stableJsonish(value: unknown): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'function') {
		return `[function ${(value as { readonly name?: string }).name || 'anonymous'}]`
	}
	if (value instanceof RegExp) return value.toString()
	if (Array.isArray(value)) return `[${value.map(stableJsonish).join(',')}]`
	if (typeof value === 'object') {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${key}:${stableJsonish(item)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}
