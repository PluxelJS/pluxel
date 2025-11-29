/**
 * Rolldown plugin to track plugin imports at compile time.
 *
 * Features:
 * - Uses rolldown filter pattern for efficient JS-Rust communication
 * - Only processes files containing @Plugin decorator
 * - Tracks both static and dynamic imports of plugin packages
 */

import type { Plugin } from 'rolldown'

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
	const includePatterns = include ?? ['**/*.ts', '**/*.tsx']
	const excludePatterns = exclude ?? ['**/node_modules/**', '**/*.d.ts']

	const collected = new Map<string, TrackedPluginUsage>()

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
			handler(_code, _id) {
				// transform hook 仅用于触发 filter，实际收集在 moduleParsed 中完成
				return null
			},
		},
		moduleParsed(moduleInfo) {
			// 只处理包含 @Plugin 的模块
			if (!moduleInfo.code?.includes('@Plugin')) return

			for (const id of moduleInfo.importedIds) {
				const name = normalizeSpecifier(id, prefixes)
				if (!name) continue
				const current = collected.get(name) ?? { hasStaticImport: false, hasDynamicImport: false }
				current.hasStaticImport = true
				collected.set(name, current)
			}
			for (const id of moduleInfo.dynamicallyImportedIds ?? []) {
				const name = normalizeSpecifier(id, prefixes)
				if (!name) continue
				const current = collected.get(name) ?? { hasStaticImport: false, hasDynamicImport: false }
				current.hasDynamicImport = true
				collected.set(name, current)
			}
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
