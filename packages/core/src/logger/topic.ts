export function normalizeTopic(input: unknown): string | null {
	const s = String(input ?? '').trim()
	return s ? s : null
}

export function matchesTopic(pattern: string, topic: string): boolean {
	if (pattern === '*') return true
	if (pattern === topic) return true
	if (pattern.endsWith(':*')) {
		const prefix = pattern.slice(0, -2)
		return topic === prefix || topic.startsWith(`${prefix}:`)
	}
	return false
}
