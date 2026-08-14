import { resolve } from 'pathe'
import { toPosixPath } from '@pluxel/runtime/internal'

export function toPosix(p: string) {
	return toPosixPath(p)
}

export function uniqSorted(items: readonly string[]): string[] {
	return [...new Set(items)].sort((a, b) => a.localeCompare(b))
}

export function uniqPreserveOrder(items: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of items) {
		const item = String(raw)
		if (seen.has(item)) continue
		seen.add(item)
		out.push(item)
	}
	return out
}

export function toRootRelative(rootDirAbs: string, absPath: string) {
	const root = toPosix(resolve(rootDirAbs))
	const abs = toPosix(resolve(absPath))
	if (abs === root) return '.'
	const prefix = root.endsWith('/') ? root : `${root}/`
	if (abs.startsWith(prefix)) return abs.slice(prefix.length)
	return abs
}
