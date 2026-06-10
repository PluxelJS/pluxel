import { isAbsolute, normalize, resolve as r } from 'pathe'
import type { EntryResolution } from './types'

export type PackageSelector = string | { name?: string | null; dir?: string | null }

export function selectorKeys(selector: PackageSelector) {
	if (typeof selector === 'string') {
		return {
			name: normalizePackageName(selector),
			dir: normalizePackageDir(selector),
		}
	}
	return {
		name: normalizePackageName(selector.name),
		dir: normalizePackageDir(selector.dir),
	}
}

export function selectorFocusHints(selector: PackageSelector): string[] {
	const focus = new Set<string>()
	const keys = selectorKeys(selector)
	if (keys.name) focus.add(keys.name)
	if (keys.dir) focus.add(keys.dir)
	return [...focus]
}

export function selectorBareName(selector: PackageSelector): string | undefined {
	if (typeof selector === 'string') return toTrimmed(selector)
	return toTrimmed(selector.name)
}

export function selectorLabel(selector: PackageSelector): string | undefined {
	if (typeof selector === 'string') return toTrimmed(selector)
	return toTrimmed(selector.name) ?? toTrimmed(selector.dir)
}

export function mergeFocus(existing: string[] | undefined, additions: string[]): string[] {
	const merged = new Set(existing)
	for (const hint of additions) {
		if (hint) merged.add(hint)
	}
	return [...merged]
}

export function missingPackageResolution(selector: PackageSelector): EntryResolution {
	const label = selectorLabel(selector)
	return {
		ok: false,
		dir: label ?? '',
		code: 'MISSING_PACKAGE',
		message: label ? `未在扫描范围内找到包 "${label}"。` : '未在扫描范围内找到目标包。',
	}
}

export function normalizePackageName(value?: string | null): string | undefined {
	const trimmed = toTrimmed(value)
	return trimmed ? trimmed.toLowerCase() : undefined
}

export function normalizePackageDir(value?: string | null): string | undefined {
	const trimmed = toTrimmed(value)
	if (!trimmed) return undefined
	const abs = isAbsolute(trimmed) ? trimmed : r(process.cwd(), trimmed)
	const normalized = normalize(abs)
	// Windows paths are case-insensitive; normalizing to lowercase improves selector matching.
	// On POSIX platforms, preserve case to avoid false collisions.
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function toTrimmed(value?: string | null): string | undefined {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}
