/**
 * Rolldown plugin to track plugin imports at compile time.
 *
 * Features:
 * - Uses hook filters to avoid per-module JS filtering in userland
 * - Only processes files containing @Plugin decorator
 * - Tracks both static and dynamic imports of plugin packages
 */

import type { ViteCompatPlugin } from './compat.ts'
import { collectImportSpecifiers } from './importCollector.ts'
import { normalizePatterns, parseWithLang } from './pluginUtils.ts'

export interface TrackedPluginUsage {
	hasStaticImport: boolean
	hasDynamicImport: boolean
}

export interface ImportTracker {
	plugin: ViteCompatPlugin
	flush(): Map<string, TrackedPluginUsage>
}

export interface ImportTrackerPluginOptions {
	/** Package name prefixes to track (e.g., ['plugin-']) */
	prefixes: string[]
	/** File patterns to include (default: *.ts, *.tsx) */
	include?: string | string[]
	/** File patterns to exclude */
	exclude?: string | string[]
}

export function createImportTracker(options: ImportTrackerPluginOptions): ImportTracker {
	const { prefixes, include, exclude } = options
	const includePatterns = normalizePatterns(include, [
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
	])
	const excludePatterns = normalizePatterns(exclude, [
		'**/node_modules/**',
		'**/*.d.ts',
		'**/*.d.mts',
		'**/*.d.cts',
	])

	const collected = new Map<string, TrackedPluginUsage>()

	const record = (specifier: string, kind: 'static' | 'dynamic') => {
		const name = normalizeSpecifier(specifier, prefixes)
		if (!name) return
		const current = collected.get(name) ?? { hasStaticImport: false, hasDynamicImport: false }
		if (kind === 'static') current.hasStaticImport = true
		else current.hasDynamicImport = true
		collected.set(name, current)
	}

	const collectFromSource = (ctx: unknown, code: string, id: string) => {
		// We intentionally inspect the authored AST instead of bundler `importedIds`, because unresolved
		// or external imports still need to be tracked.
		const ast = parseWithLang(ctx, code, id)
		if (!ast) return
		for (const item of collectImportSpecifiers(ast)) record(item.specifier, item.kind)
	}

	const plugin: ViteCompatPlugin = {
		name: 'pluxel-import-tracker',
		buildStart() {
			collected.clear()
		},
		transform: {
			filter: {
				id: {
					include: includePatterns,
					exclude: excludePatterns,
				},
				// 只处理包含 @Plugin 的文件
				code: {
					include: /@Plugin|\bPlugin\s*\(|__decorate\s*\(/,
				},
			},
			handler(code, id) {
				collectFromSource(this, code, id)
				return null
			},
		},
	}

	return {
		plugin,
		flush() {
			const next = new Map(collected)
			collected.clear()
			return next
		},
	}
}

function normalizeSpecifier(source: string, prefixes: string[]) {
	const clean = source.split(/[?#]/, 1)[0] ?? source
	if (!clean || clean.startsWith('.') || clean.startsWith('/')) return undefined

	if (clean.startsWith('@')) {
		const [scope, name = ''] = clean.split('/')
		return name && hasSupportedPrefix(name, prefixes) ? `${scope}/${name}` : undefined
	}

	const [name] = clean.split('/')
	return name && hasSupportedPrefix(name, prefixes) ? name : undefined
}

function hasSupportedPrefix(name: string, prefixes: string[]) {
	return prefixes.some((prefix) => name.startsWith(prefix))
}
