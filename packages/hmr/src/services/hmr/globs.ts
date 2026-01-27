import { isAbsolute, resolve } from 'pathe'
import { normalizePath } from 'vite'

export function resolveGlobPatterns(
	patterns: readonly string[] | undefined,
	cwd: string,
): string[] | undefined {
	if (!patterns?.length) return undefined
	return patterns.map((pattern) => {
		const negated = pattern.startsWith('!')
		const raw = negated ? pattern.slice(1) : pattern
		const normalized = isAbsolute(raw) ? normalizePath(raw) : normalizePath(resolve(cwd, raw))
		return negated ? `!${normalized}` : normalized
	})
}

