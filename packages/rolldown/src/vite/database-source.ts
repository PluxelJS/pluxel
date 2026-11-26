import { readFile } from 'node:fs/promises'
import MagicString from 'magic-string'
import { relative, resolve } from 'pathe'
import type { Plugin } from 'vite'
import { findDatabasePackageRoot } from '../database/artifact.ts'
import { resolveDatabaseArtifact } from '../database/source.ts'
import { extractDatabaseDeclarations, mayDeclareDatabase } from '../database/declaration.ts'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import { normalizeViteId } from '../rolldown/plugins/viteNormalizeId.ts'

export function databaseSourceVitePlugin(options: { root?: string } = {}): Plugin {
	const root = resolve(options.root ?? process.cwd())
	const packages = new Map<string, string>()
	return {
		name: 'pluxel:database-source',
		enforce: 'pre',
		buildStart() {
			packages.clear()
		},
		async transform(code, rawId) {
			if (!mayDeclareDatabase(code)) return null
			const id = normalizeViteId(rawId)
			if (!/\.[cm]?[jt]sx?$/.test(id) || /\.d\.[cm]?ts$/.test(id)) return null
			const packageRoot = findDatabasePackageRoot(id, root)
			if (packageRoot && relative(packageRoot, id).startsWith('dist/')) return null
			const ast = parseStandaloneWithLang(code, id)
			if (!ast) this.error(`[database] failed to parse database declaration module: ${id}`)
			const declarations = extractDatabaseDeclarations(ast, code, id)
			if (declarations.length === 0) return null
			if (!packageRoot) this.error(`[database] cannot locate package.json for ${id}`)
			let existing = packages.get(packageRoot)
			while (existing && existing !== id) {
				const stillDeclared = await declaresDatabase(existing)
				// Another transform may have replaced a stale owner while this file was read.
				// Recheck before claiming so concurrent replacements cannot both succeed.
				if (packages.get(packageRoot) !== existing) {
					existing = packages.get(packageRoot)
					continue
				}
				if (stillDeclared) {
					this.error(
						`[database] package ${packageRoot} declares databases in both ${existing} and ${id}`,
					)
				}
				packages.delete(packageRoot)
				existing = undefined
			}
			packages.set(packageRoot, id)

			const declaration = declarations[0]!
			const loaded = await resolveDatabaseArtifact(packageRoot, id, declaration, (file) =>
				this.addWatchFile(file),
			)
			const transformed = new MagicString(code)
			transformed.appendLeft(declaration.insertOffset, `, ${JSON.stringify(loaded.artifact)}`)
			return {
				code: transformed.toString(),
				map: transformed.generateMap({ source: id, includeContent: true, hires: true }),
			}
		},
	}
}

async function declaresDatabase(id: string): Promise<boolean> {
	let code: string
	try {
		code = await readFile(id, 'utf8')
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
			return false
		throw error
	}
	if (!mayDeclareDatabase(code)) return false
	const ast = parseStandaloneWithLang(code, id)
	if (!ast) throw new Error(`[database] failed to parse database declaration module: ${id}`)
	return extractDatabaseDeclarations(ast, code, id).length > 0
}
