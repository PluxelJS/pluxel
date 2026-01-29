/**
 * Rolldown plugin to track plugin imports at compile time.
 *
 * Features:
 * - Uses rolldown filter pattern for efficient JS-Rust communication
 * - Only processes files containing @Plugin decorator
 * - Tracks both static and dynamic imports of plugin packages
 */

import type { Plugin } from 'rolldown'
import { normalizePatterns } from './pluginUtils'

export interface TrackedPluginUsage {
	hasStaticImport: boolean
	hasDynamicImport: boolean
}

export interface ImportTracker {
	plugin: Plugin
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
	const includePatterns = normalizePatterns(include, ['**/*.ts', '**/*.tsx'])
	const excludePatterns = normalizePatterns(exclude, ['**/node_modules/**', '**/*.d.ts'])

	const collected = new Map<string, TrackedPluginUsage>()

	const record = (specifier: string, kind: 'static' | 'dynamic') => {
		const name = normalizeSpecifier(specifier, prefixes)
		if (!name) return
		const current = collected.get(name) ?? { hasStaticImport: false, hasDynamicImport: false }
		if (kind === 'static') current.hasStaticImport = true
		else current.hasDynamicImport = true
		collected.set(name, current)
	}

	const collectFromSource = (code: string) => {
		// We intentionally parse via regex to also capture external/unresolved imports,
		// which may not be present in `moduleParsed().importedIds` depending on bundler internals.
		//
		// Static:
		// - import 'pkg'
		// - import x from 'pkg'
		// - export * from 'pkg'
		// Dynamic:
		// - import('pkg')
		const staticRe =
			/\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g
		const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

		for (const match of code.matchAll(staticRe)) {
			const spec = match[1]
			if (spec) record(spec, 'static')
		}
		for (const match of code.matchAll(dynamicRe)) {
			const spec = match[1]
			if (spec) record(spec, 'dynamic')
		}
	}

	const plugin: Plugin = {
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
					include: /@Plugin/,
				},
			},
			handler(code, _id) {
				collectFromSource(code)
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
