import { resolve } from 'pathe'
import {
	findDatabasePackageRoot,
	loadDatabaseArtifactForSource,
	type DatabaseBuildArtifact,
} from '../database/artifact.ts'
import { extractDatabaseDeclarations } from '../database/declaration.ts'
import { generateResetDatabaseArtifact } from '../database/reset-artifact.ts'
import type { ViteCompatPlugin } from '../rolldown/plugins/compat.ts'
import { parseStandaloneWithLang } from '../rolldown/plugins/pluginUtils.ts'
import { normalizeViteId } from '../rolldown/plugins/viteNormalizeId.ts'

const DATABASE_CODE_HINT = /\bdefineDatabase\s*\(/

export function databaseSourceVitePlugin(options: { root?: string } = {}): ViteCompatPlugin {
	const root = resolve(options.root ?? process.cwd())
	const packages = new Map<string, string>()
	return {
		name: 'pluxel:database-source',
		enforce: 'pre',
		buildStart() {
			packages.clear()
		},
		async transform(code, rawId) {
			if (!DATABASE_CODE_HINT.test(code)) return null
			const id = normalizeViteId(rawId)
			const ast = parseStandaloneWithLang(code, id)
			if (!ast) this.error(`[database] failed to parse database declaration module: ${id}`)
			const declarations = extractDatabaseDeclarations(ast, code, id)
			if (declarations.length === 0) return null
			const packageRoot = findDatabasePackageRoot(id, root)
			if (!packageRoot) this.error(`[database] cannot locate package.json for ${id}`)
			const existing = packages.get(packageRoot)
			if (existing && existing !== id) {
				this.error(
					`[database] package ${packageRoot} declares databases in both ${existing} and ${id}`,
				)
			}
			packages.set(packageRoot, id)

			const declaration = declarations[0]!
			let artifact: DatabaseBuildArtifact
			if (declaration.evolution === 'reset-on-schema-change') {
				const generated = await generateResetDatabaseArtifact({ root: packageRoot, schema: id })
				try {
					artifact = generated.artifact
				} finally {
					await generated.cleanup()
				}
			} else {
				const loaded = await loadDatabaseArtifactForSource(id, root)
				artifact = loaded.artifact
			}
			if (artifact.evolution !== declaration.evolution) {
				this.error(
					`[database] ${id} declares evolution "${declaration.evolution}" but its artifact uses "${artifact.evolution}"`,
				)
			}
			const value = JSON.stringify(artifact)
			let transformed = code
			for (const item of declarations.sort(
				(left, right) => right.insertOffset - left.insertOffset,
			)) {
				transformed = `${transformed.slice(0, item.insertOffset)}, ${value}${transformed.slice(item.insertOffset)}`
			}
			return { code: transformed, map: null }
		},
	}
}
