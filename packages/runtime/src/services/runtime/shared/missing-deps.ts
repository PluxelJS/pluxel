export type MissingDepsCandidate = {
	/** Plugin name as used by loader/config (usually plugin id). */
	name: string
	/** Optional ctor.name (helpful when error chains contain class names). */
	ctorName?: string
	/** Optional plugin id (when different from name). */
	pluginId?: string
}

function normalizeDependencyToken(raw: string): string {
	const text = raw.trim()
	// Common presentation: "Foo(FooCtor)" → "Foo"
	const m = text.match(/^(.+)\([^)]*\)$/)
	return (m ? m[1] : text).trim()
}

function extractMissingDependencyChains(detail: string): string[][] {
	// Example (diod):
	//   [MissingDependency] Otlp | chain: UniverLoopbackPlugin -> Otlp
	const out: string[][] = []
	const re = /chain:\s*([^\n\r]+)/g
	for (;;) {
		const m = re.exec(detail)
		if (!m) break
		const chainText = m[1] ?? ''
		const parts = chainText
			.split(/->|→/g)
			.map((s) => normalizeDependencyToken(s))
			.filter(Boolean)
		if (parts.length > 0) out.push(parts)
	}

	// Example (a plugin package):
	//   [MissingDependency] Bad -> MissingBase
	const simple = /\[MissingDependency\]\s*([^\n\r|]+?)\s*->\s*([^\n\r]+)/g
	for (;;) {
		const m = simple.exec(detail)
		if (!m) break
		const from = normalizeDependencyToken(m[1] ?? '')
		const to = normalizeDependencyToken(m[2] ?? '')
		if (from && to) out.push([from, to])
	}

	return out
}

function isMissingDependencyError(detail: string): boolean {
	return detail.includes('MissingDependency') || detail.includes('[MissingDependency]')
}

function collectErrorDetail(error: unknown, seen = new Set<unknown>()): string {
	if (error === null || error === undefined || seen.has(error)) return ''
	if (typeof error === 'object' || typeof error === 'function') seen.add(error)

	const parts: string[] = []
	if (typeof error === 'string') {
		parts.push(error)
	} else if (error instanceof Error) {
		if (error.message) parts.push(error.message)
		const text = error.toString()
		if (text && text !== error.message) parts.push(text)
		const cause = (error as Error & { cause?: unknown }).cause
		if (cause !== undefined) {
			const nested = collectErrorDetail(cause, seen)
			if (nested) parts.push(nested)
		}
	} else {
		parts.push(String(error))
	}

	return parts.filter(Boolean).join('\n')
}

export function disablePluginsOnMissingDependencyError(params: {
	error: unknown
	candidates: Iterable<MissingDepsCandidate>
	isEnabled: (name: string) => boolean
	disable: (name: string) => void
	batch?: (run: () => void) => void
	logger?: { warn: (message: string, props?: Record<string, unknown>) => void }
	stage?: string
	message?: string
}): Set<string> {
	const detail = collectErrorDetail(params.error)
	if (!isMissingDependencyError(detail)) return new Set()

	const tokenToName = new Map<string, string>()
	for (const c of params.candidates) {
		const name = typeof c?.name === 'string' ? c.name.trim() : ''
		if (!name) continue

		tokenToName.set(normalizeDependencyToken(name), name)

		const ctorName = typeof c.ctorName === 'string' ? c.ctorName.trim() : ''
		if (ctorName) tokenToName.set(normalizeDependencyToken(ctorName), name)

		const pluginId = typeof c.pluginId === 'string' ? c.pluginId.trim() : ''
		if (pluginId) tokenToName.set(normalizeDependencyToken(pluginId), name)
	}

	const chains = extractMissingDependencyChains(detail)
	if (chains.length === 0) return new Set()

	const toDisable = new Set<string>()
	for (const chain of chains) {
		// Disable any known plugin token in the chain (excluding the missing dependency token at the end).
		for (let i = 0; i < chain.length - 1; i++) {
			const token = chain[i]
			const mapped = tokenToName.get(token)
			if (mapped) toDisable.add(mapped)
		}
	}
	if (toDisable.size === 0) return new Set()

	const disabled = new Set<string>()
	const batch = params.batch ?? ((run) => run())
	batch(() => {
		for (const name of toDisable) {
			if (!params.isEnabled(name)) continue
			params.disable(name)
			disabled.add(name)
		}
	})

	if (disabled.size > 0 && params.logger) {
		params.logger.warn(params.message ?? 'auto-disabled plugins due to missing dependencies', {
			stage: params.stage,
			disabled: [...disabled].sort(),
			error: params.error,
		})
	}

	return disabled
}
