import type { Plugin } from 'rolldown'

export interface TrackedPluginUsage {
	hasStaticImport: boolean
	hasDynamicImport: boolean
}

export interface ImportTracker {
	plugin: Plugin
	flush(): Map<string, TrackedPluginUsage>
}

export function createImportTracker(prefixes: string[]): ImportTracker {
	const collected = new Map<string, TrackedPluginUsage>()

	// 直接挂在 Rolldown 的模块解析过程中捕获 import，避免手动遍历文件
	const plugin: Plugin = {
		name: 'pluxel-import-tracker',
		buildStart() {
			collected.clear()
		},
		moduleParsed(moduleInfo) {
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
