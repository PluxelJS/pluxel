import type { GroupConfig } from './types'

export const genGroupId = () =>
	globalThis.crypto?.randomUUID?.() ??
	`g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export function sanitize(allIds: string[], groups: GroupConfig[]) {
	const seen = new Set<string>()
	const allow = new Set(allIds)
	const nextGroups = groups.map((g) => ({
		groupId: g.groupId,
		name: g.name,
		pluginIds: g.pluginIds
			.filter((id) => allow.has(id))
			.filter((id) => !seen.has(id) && (seen.add(id), true)),
	}))
	const ungrouped = allIds.filter((id) => !seen.has(id))
	return { groups: nextGroups, ungrouped }
}

export const unique = (arr: string[]) => Array.from(new Set(arr))

export const arraysEqual = (a: string[], b: string[]) => {
	if (a === b) return true
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false
	}
	return true
}

export const assertNoDup = (groups: GroupConfig[], ungrouped: string[]) => {
	if (process.env.NODE_ENV !== 'production') {
		const seen = new Map<string, number>()
		for (const id of ungrouped) seen.set(id, (seen.get(id) ?? 0) + 1)
		for (const g of groups) for (const id of g.pluginIds) seen.set(id, (seen.get(id) ?? 0) + 1)
		const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
		if (dup.length > 0) console.warn('[PluginOrganizer] Duplicate ids detected:', dup)
	}
}

export const COLLAPSE_STORAGE_KEY = 'pluxel:plugin-organizer:collapsed'

export const readCollapsedState = (): Record<string, boolean> => {
	if (typeof window === 'undefined') return {}
	try {
		const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
		if (!raw) return {}
		const parsed = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			return parsed.reduce<Record<string, boolean>>((acc, id) => {
				if (typeof id === 'string') acc[id] = true
				return acc
			}, {})
		}
		if (parsed && typeof parsed === 'object') {
			const acc: Record<string, boolean> = {}
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === 'boolean' && value) acc[key] = true
			}
			return acc
		}
	} catch (error) {
		console.warn('[PluginOrganizer] Failed to parse collapse state', error)
	}
	return {}
}

export function deriveRootLabel(moduleId: string | null | undefined, statusName: string) {
	if (!moduleId) return '本地插件'
	const normalized = moduleId.replaceAll('\\', '/')
	const parts = normalized.split('/').filter(Boolean)
	if (parts.length === 0) return '本地插件'
	const last = parts.at(-1) ?? ''
	if (/\.[a-z0-9]+$/i.test(last)) parts.pop()
	const skip = new Set(['src', 'lib', 'dist', 'build'])
	let candidate = parts.at(-1) ?? ''
	while (candidate && skip.has(candidate) && parts.length > 1) {
		parts.pop()
		candidate = parts.at(-1) ?? ''
	}
	const normalizedCandidate = candidate.toLowerCase()
	const normalizedName = statusName.toLowerCase()
	if (normalizedCandidate === normalizedName && parts.length > 1) {
		parts.pop()
		candidate = parts.at(-1) ?? candidate
		while (candidate && skip.has(candidate) && parts.length > 1) {
			parts.pop()
			candidate = parts.at(-1) ?? candidate
		}
	}
	return candidate || '本地插件'
}
