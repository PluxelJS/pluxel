import { builtinModules } from 'node:module'
import type { Plugin } from 'vite'

const BUILTIN_SET = (() => {
	const set = new Set<string>()
	for (const id of builtinModules) {
		set.add(id)
		if (id.startsWith('node:')) set.add(id.slice('node:'.length))
		else set.add(`node:${id}`)
	}
	return set
})()

const escapeRegExp = (value: string) => value.replaceAll(/[\\^$.*+?()[\]{}|]/g, '\\$&')
const BUILTIN_ID_ALTERNATION = [...BUILTIN_SET]
	.sort((a, b) => b.length - a.length)
	.map(escapeRegExp)
	.join('|')
const BUILTIN_RESOLVE_ID_FILTER = new RegExp(
	`^(?:${BUILTIN_ID_ALTERNATION}|\\0?(?:__vite-browser-external:|vite-browser-external:)(?:${BUILTIN_ID_ALTERNATION}))$`,
)

function unwrapViteBrowserExternalId(source: string): string | null {
	const s = source.startsWith('\0') ? source.slice(1) : source
	const prefixes = ['__vite-browser-external:', 'vite-browser-external:']
	for (const prefix of prefixes) {
		if (s.startsWith(prefix)) return s.slice(prefix.length)
	}
	return null
}

function isClientEnvironment(context: unknown): boolean {
	const envName = (context as { environment?: { name?: string } } | null)?.environment?.name
	return envName ? envName === 'client' : true
}

function formatHint(params: { source: string; importer?: string }) {
	const lines = [
		`[pluxel-hmr] Node-only import detected in the browser (client) environment: "${params.source}"`,
		params.importer ? `Importer: ${params.importer}` : null,
		'',
		'This usually means a plugin UI entry imported server-only code.',
		'Fix: split UI vs server modules, and keep Node dependencies (e.g. undici, node:*) on the runner/SSR side.',
	]
	return lines.filter(Boolean).join('\n')
}

/**
 * Fail fast when the Vite **client** environment tries to resolve Node-only imports.
 *
 * This avoids confusing pre-transform errors and points directly at the offending importer.
 */
export function clientNodeImportGuardPlugin(): Plugin {
	return {
		name: 'pluxel:client-node-import-guard',
		apply: 'serve',
		resolveId: {
			filter: {
				id: BUILTIN_RESOLVE_ID_FILTER,
			},
			handler(source, importer) {
				if (!isClientEnvironment(this)) return null

				// Keep this conservative; the goal is to catch clear Node-only modules.
				const unwrapped = typeof source === 'string' ? unwrapViteBrowserExternalId(source) : null
				if (typeof source === 'string' && BUILTIN_SET.has(source))
					this.error(formatHint({ source, importer }))
				if (typeof unwrapped === 'string' && BUILTIN_SET.has(unwrapped)) {
					this.error(formatHint({ source: unwrapped, importer }))
				}

				return null
			},
		},
	}
}
