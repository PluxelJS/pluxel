function normalizeTopic(input: unknown): string | null {
	const s = String(input ?? '').trim()
	return s ? s : null
}

function getDebugPatterns(): readonly string[] {
	const w = globalThis as unknown as { __PLUXEL_DEBUG__?: unknown; localStorage?: Storage }
	const raw =
		typeof w.__PLUXEL_DEBUG__ === 'string'
			? w.__PLUXEL_DEBUG__
			: (w.localStorage?.getItem('PLUXEL_DEBUG') ?? '')
	const parts = raw
		.split(/[,\s]+/g)
		.map((s) => s.trim())
		.filter(Boolean)
	return Array.from(new Set(parts))
}

function matchesTopic(pattern: string, topic: string): boolean {
	if (pattern === '*') return true
	if (pattern === topic) return true
	if (pattern.endsWith(':*')) {
		const prefix = pattern.slice(0, -2)
		return topic === prefix || topic.startsWith(`${prefix}:`)
	}
	return false
}

export type DebugLogger = (...args: unknown[]) => void

export function createDebug(topic: string): DebugLogger {
	const t = normalizeTopic(topic)
	if (!t) return (..._args: unknown[]) => undefined
	return (...args: unknown[]) => {
		const patterns = getDebugPatterns()
		let enabled = false
		for (const p of patterns) {
			if (matchesTopic(p, t)) {
				enabled = true
				break
			}
		}
		if (!enabled) return

		if (typeof args[0] === 'string') {
			const [fmt, ...rest] = args as [string, ...unknown[]]
			console.debug(`[${t}] ${fmt}`, ...rest)
			return
		}
		console.debug(`[${t}]`, ...args)
	}
}

export const extLog = createDebug('pluxel:ext:loader')
export const extRuntime = createDebug('pluxel:ext:runtime')
