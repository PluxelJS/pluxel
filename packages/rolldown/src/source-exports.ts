import { resolve } from 'node:path'

/** Source entries shared by package lowering and modules application output. */
export function readSourceExportEntries(
	value: unknown,
	packageRoot: string,
	error: (message: string) => never,
	explicitJavaScript = true,
): Map<string, string> {
	const entries = new Map<string, string>()
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		error('[pluxel:plugin-package] package exports must be an explicit subpath map')
	}
	for (const [subpath, target] of Object.entries(value as Record<string, unknown>)) {
		if (subpath !== '.' && !subpath.startsWith('./'))
			error('[pluxel:plugin-package] package exports must be an explicit subpath map')
		// A known Plugin package also validates unconditional JS exports. Modules output
		// requires source opt-in for JS so built defaults do not become compilation inputs.
		const source = readSourceCondition(target, explicitJavaScript && typeof target === 'string')
		if (!source) continue
		if (!source.startsWith('./'))
			error(`[pluxel:plugin-package] public source export must be package-relative: ${subpath}`)
		entries.set(subpath, resolve(packageRoot, source))
	}
	return entries
}

export function readSourceCondition(value: unknown, explicitSource = false): string | undefined {
	if (typeof value === 'string') {
		if (/\.d\.[cm]?tsx?$/.test(value)) return undefined
		const extension = explicitSource ? /\.(?:[cm]?[jt]s|[jt]sx)$/ : /\.(?:[cm]?ts|tsx)$/
		return extension.test(value) ? value : undefined
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Record<string, unknown>
	for (const key of ['@pluxel/hmr', '@pluxel/source', 'development']) {
		const nested = readSourceCondition(record[key], true)
		if (nested) return nested
	}
	for (const key of ['import', 'default']) {
		const nested = readSourceCondition(record[key], explicitSource)
		if (nested) return nested
	}
	return undefined
}
