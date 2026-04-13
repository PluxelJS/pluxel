import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'pathe'
import { boundedSet, resolveCacheLimit } from './cache'

export function toPosixPath(value: string): string {
	if (!value) return value
	return value.includes('\\') ? value.replaceAll('\\', '/') : value
}

const nsToMs = (ns: bigint) => Number(ns) / 1e6

export const startTimer = () => {
	const t0 = process.hrtime.bigint()
	return () => nsToMs(process.hrtime.bigint() - t0)
}

let pkgrootCacheLimit = 2_000
const pkgRootCache = new Map<string, string | null>()

export function setPkgrootCacheLimit(raw: unknown) {
	pkgrootCacheLimit = resolveCacheLimit(raw, 2_000)
	if (pkgrootCacheLimit <= 0) pkgRootCache.clear()
}

export const findNearestPackageRoot = (start: string): string | null => {
	try {
		let current = toPosixPath(start)
		if (pkgrootCacheLimit > 0) {
			const cached = pkgRootCache.get(current)
			if (cached !== undefined) return cached
		}

		const visited: string[] = []
		while (true) {
			visited.push(current)

			if (pkgrootCacheLimit > 0) {
				const cached = pkgRootCache.get(current)
				if (cached !== undefined) {
					for (const dir of visited) boundedSet(pkgRootCache, dir, cached, pkgrootCacheLimit)
					return cached
				}
			}

			if (existsSync(resolve(current, 'package.json'))) {
				const root = toPosixPath(current)
				for (const dir of visited) boundedSet(pkgRootCache, dir, root, pkgrootCacheLimit)
				return root
			}
			const parent = dirname(current)
			if (parent === current) {
				for (const dir of visited) boundedSet(pkgRootCache, dir, null, pkgrootCacheLimit)
				return null
			}
			current = parent
		}
	} catch {
		return null
	}
}

export function tryRealpathSync(p: string): string {
	try {
		const fn: (p: string) => string =
			typeof (realpathSync as unknown as { native?: unknown })?.native === 'function'
				? (realpathSync as unknown as { native: (p: string) => string }).native
				: realpathSync
		return toPosixPath(fn(p))
	} catch {
		return toPosixPath(p)
	}
}

export function pathVariantsAbs(absNormalizedPath: string): string[] {
	const abs = toPosixPath(absNormalizedPath)
	const real = tryRealpathSync(abs)
	return real && real !== abs ? [abs, real] : [abs]
}

export function resolveGlobPatterns(
	patterns: readonly string[] | undefined,
	cwd: string,
): string[] | undefined {
	if (!patterns?.length) return undefined
	const out: string[] = []
	const seen = new Set<string>()

	const push = (p: string) => {
		if (!p) return
		if (seen.has(p)) return
		seen.add(p)
		out.push(p)
	}

	const firstGlobIndex = (p: string) => {
		for (let i = 0; i < p.length; i++) {
			const ch = p.charCodeAt(i)
			if (
				ch === 42 || // *
				ch === 63 || // ?
				ch === 91 || // [
				ch === 93 || // ]
				ch === 123 || // {
				ch === 125 || // }
				ch === 40 || // (
				ch === 41 // )
			) {
				return i
			}
		}
		return -1
	}

	const expandRealpathVariant = (absPattern: string): string[] => {
		const idx = firstGlobIndex(absPattern)
		const prefix = idx >= 0 ? absPattern.slice(0, idx) : absPattern
		const suffix = idx >= 0 ? absPattern.slice(idx) : ''

		const hasTrailingSlash = prefix.endsWith('/')
		const prefixPath = hasTrailingSlash ? prefix.slice(0, -1) : prefix
		const canonical = toPosixPath(tryRealpathSync(prefixPath))
		const canonicalPrefix = hasTrailingSlash ? `${canonical}/` : canonical

		if (canonicalPrefix && canonicalPrefix !== prefix)
			return [absPattern, `${canonicalPrefix}${suffix}`]
		return [absPattern]
	}

	for (const pattern of patterns) {
		const negated = pattern.startsWith('!')
		const raw = negated ? pattern.slice(1) : pattern
		const absPattern = isAbsolute(raw) ? toPosixPath(raw) : toPosixPath(resolve(cwd, raw))

		for (const variant of expandRealpathVariant(absPattern)) {
			push(negated ? `!${variant}` : variant)
		}
	}

	return out
}
