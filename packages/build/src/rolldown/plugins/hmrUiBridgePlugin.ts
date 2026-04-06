/**
 * Rolldown/Vite plugin to lower `@pluxel/hmr/plugin` `ui(...)` declarations into
 * runtime packaged registration helpers during build.
 *
 * Goal:
 * - Keep author-facing source on `ui(...).bind(ctx)` for HMR / AST recognition.
 * - Remove HMR bridge semantics from production build outputs.
 * - Preserve the same local binding name so existing source structure keeps working.
 *
 * Example:
 *   import { ui } from '@pluxel/hmr/plugin'
 *   const pluginUi = ui('./ui/index.tsx')
 *   pluginUi.bind(this.ctx)
 *
 * becomes:
 *   function __pluxelRuntimeUiBridge__(input) { ... return { bind(ctx) { return ctx.ext.ui.remote.packaged() } } }
 *   const ui = __pluxelRuntimeUiBridge__
 *   const pluginUi = ui('./ui/index.tsx')
 *   pluginUi.bind(this.ctx)
 */

import type { ImportDeclaration, ImportSpecifier, Program } from 'oxc-parser'
import type { TransformPluginContext } from 'rolldown'
import type { ViteCompatPlugin } from './compat'
import { allowOptionalQuerySuffix } from './compat'
import { normalizeViteId } from './viteNormalizeId'
import { normalizePatterns, parseWithLang } from './pluginUtils'

export interface HmrUiBridgePluginOptions {
	include?: string | string[]
	exclude?: string | string[]
}

interface ImportRewrite {
	start: number
	end: number
	replacement: string
}

const HMR_PLUGIN_SOURCE = '@pluxel/hmr/plugin'
const CODE_HINT = /@pluxel\/hmr\/plugin/

export function hmrUiBridgePlugin(options: HmrUiBridgePluginOptions = {}): ViteCompatPlugin {
	const includePatterns = normalizePatterns(options.include, [
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
		'**/*.js',
		'**/*.jsx',
		'**/*.mjs',
		'**/*.cjs',
	]).map(allowOptionalQuerySuffix)
	const excludePatterns = normalizePatterns(options.exclude, [
		'**/node_modules/**',
		'**/*.d.ts',
		'**/*.d.mts',
		'**/*.d.cts',
	]).map(allowOptionalQuerySuffix)

	return {
		name: 'pluxel-hmr-ui-bridge',
		enforce: 'pre',
		transform: {
			filter: {
				id: {
					include: includePatterns,
					exclude: excludePatterns,
				},
				code: {
					include: CODE_HINT,
				},
			},
			handler(this: TransformPluginContext, code, id) {
				const normalizedId = normalizeViteId(id)
				const ast = parseWithLang(this, code, normalizedId)
				if (!ast) {
					this.warn(`Failed to parse ${id}`)
					return null
				}

				try {
					const rewritten = rewriteHmrUiBridge(code, ast)
					if (!rewritten) return null
					return { code: rewritten, map: null as null }
				} catch (error) {
					if (error instanceof Error && error.message.startsWith('[pluxel-hmr-ui-bridge]')) {
						this.error(error.message)
					}
					this.warn(`Failed to rewrite HMR ui bridge in ${id}: ${error}`)
					return null
				}
			},
		},
	}
}

function rewriteHmrUiBridge(code: string, ast: Program): string | null {
	const importDecls = ast.body.filter(
		(node): node is ImportDeclaration => node.type === 'ImportDeclaration',
	)
	if (importDecls.length === 0) return null

	const lastImportEnd = importDecls.reduce((max, node) => Math.max(max, node.end), 0)
	const localNames = new Set<string>()
	const rewrites: ImportRewrite[] = []

	for (const node of importDecls) {
		if (String(node.source.value ?? '') !== HMR_PLUGIN_SOURCE) continue
		if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) continue
		assertSupportedHmrImports(node)

		const kept = []
		let removedAny = false

		for (const spec of node.specifiers) {
			if (spec.type === 'ImportSpecifier' && getImportedName(spec) === 'ui') {
				localNames.add(spec.local.name)
				removedAny = true
				continue
			}
			kept.push(spec)
		}

		if (!removedAny) continue
		rewrites.push({
			start: node.start,
			end: node.end,
			replacement: renderImportDeclaration(node, kept),
		})
	}

	if (rewrites.length === 0 || localNames.size === 0) return null

	const helperName = createUniqueHelperName(code, localNames)
	const helperBlock = buildHelperBlock(helperName, [...localNames])
	const edits: ImportRewrite[] = [
		...rewrites,
		{ start: lastImportEnd, end: lastImportEnd, replacement: helperBlock },
	]

	let result = code
	edits.sort((a, b) => b.start - a.start)
	for (const edit of edits) {
		result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
	}

	return result
}

function assertSupportedHmrImports(node: ImportDeclaration): void {
	for (const spec of node.specifiers ?? []) {
		if (spec.type === 'ImportDefaultSpecifier') {
			throw new Error(
				`[pluxel-hmr-ui-bridge] default import is not supported for ${HMR_PLUGIN_SOURCE}; use named imports like \`import { ui, worker } from '${HMR_PLUGIN_SOURCE}'\``,
			)
		}
		if (spec.type === 'ImportNamespaceSpecifier') {
			throw new Error(
				`[pluxel-hmr-ui-bridge] namespace import is not supported for ${HMR_PLUGIN_SOURCE}; use named imports like \`import { ui, worker } from '${HMR_PLUGIN_SOURCE}'\``,
			)
		}
	}
}

function renderImportDeclaration(
	node: ImportDeclaration,
	specifiers: NonNullable<ImportDeclaration['specifiers']>,
): string {
	if (specifiers.length === 0) return ''

	const prefix = node.importKind === 'type' ? 'import type ' : 'import '
	let defaultLocal: string | null = null
	let namespaceLocal: string | null = null
	const named: string[] = []

	for (const spec of specifiers) {
		if (spec.type === 'ImportDefaultSpecifier') {
			defaultLocal = spec.local.name
			continue
		}
		if (spec.type === 'ImportNamespaceSpecifier') {
			namespaceLocal = spec.local.name
			continue
		}
		if (spec.type === 'ImportSpecifier') {
			named.push(renderNamedImportSpecifier(spec))
		}
	}

	const clauses: string[] = []
	if (defaultLocal) clauses.push(defaultLocal)
	if (namespaceLocal) clauses.push(`* as ${namespaceLocal}`)
	if (named.length > 0) clauses.push(`{ ${named.join(', ')} }`)
	if (clauses.length === 0) return ''

	return `${prefix}${clauses.join(', ')} from ${JSON.stringify(String(node.source.value ?? ''))};`
}

function renderNamedImportSpecifier(spec: ImportSpecifier): string {
	const imported = getImportedName(spec)
	const local = spec.local.name
	const alias = imported === local ? imported : `${imported} as ${local}`
	return spec.importKind === 'type' ? `type ${alias}` : alias
}

function getImportedName(spec: ImportSpecifier): string {
	const imported = spec.imported
	if (
		imported &&
		typeof imported === 'object' &&
		'name' in imported &&
		typeof imported.name === 'string'
	) {
		return imported.name
	}
	return spec.local.name
}

function createUniqueHelperName(code: string, localNames: Set<string>): string {
	let name = '__pluxelRuntimeUiBridge__'
	while (localNames.has(name) || code.includes(name)) {
		name = `_${name}`
	}
	return name
}

function buildHelperBlock(helperName: string, localNames: string[]): string {
	const aliasLines = localNames.map((localName) => `const ${localName} = ${helperName}`).join('\n')
	return [
		'',
		'// [pluxel-hmr-ui-bridge] Injected runtime packaged bridge',
		`function ${helperName}(input) {`,
		"\tconst entryPath = typeof input === 'string' ? String(input).trim() : String(input?.entryPath ?? '').trim()",
		"\tif (!entryPath) throw new Error('[pluxel/hmr] ui(): entryPath required')",
		'\treturn {',
		'\t\tbind(ctx) {',
		'\t\t\treturn ctx.ext.ui.remote.packaged()',
		'\t\t},',
		'\t}',
		'}',
		aliasLines,
		'',
	].join('\n')
}
