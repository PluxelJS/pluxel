import { useEffect, useState } from 'react'

type NumericLayout = Record<string, number>

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function hasSameLayout<T extends NumericLayout>(left: T, right: T) {
	const keys = Object.keys(left)
	if (keys.length !== Object.keys(right).length) return false
	return keys.every((key) => Math.abs((left[key] ?? 0) - (right[key] ?? 0)) < 0.01)
}

export function sanitizeTwoPanelLayout<T extends NumericLayout>(
	layout: T,
	fallback: T,
	primaryId: keyof T,
	minPrimary: number,
	minSecondary: number,
): T {
	const ids = Object.keys(fallback) as Array<keyof T>
	if (ids.length !== 2) return fallback
	const secondaryId = ids.find((id) => id !== primaryId)
	if (!secondaryId) return fallback

	const primaryRaw = layout[primaryId]
	const secondaryRaw = layout[secondaryId]
	if (!Number.isFinite(primaryRaw) || !Number.isFinite(secondaryRaw)) return fallback

	const sum = primaryRaw + secondaryRaw
	if (!Number.isFinite(sum) || sum <= 0) return fallback

	const primaryNormalized = (primaryRaw / sum) * 100
	const maxPrimary = 100 - minSecondary
	const clampedPrimary = Math.min(maxPrimary, Math.max(minPrimary, primaryNormalized))
	const clampedSecondary = 100 - clampedPrimary

	return {
		...fallback,
		[primaryId]: clampedPrimary,
		[secondaryId]: clampedSecondary,
	}
}

function readStoredLayout<T extends NumericLayout>(
	key: string,
	fallback: T,
	sanitize?: (layout: T) => T,
): T {
	if (typeof window === 'undefined') return fallback
	try {
		const raw = window.localStorage.getItem(key)
		if (!raw) return fallback
		const parsed = JSON.parse(raw)
		if (!isRecord(parsed)) return fallback
		const next = { ...fallback }
		for (const id of Object.keys(fallback)) {
			if (typeof parsed[id] === 'number') next[id as keyof T] = parsed[id] as T[keyof T]
		}
		return sanitize ? sanitize(next) : next
	} catch {
		return fallback
	}
}

export function useStoredLayout<T extends NumericLayout>(
	key: string,
	fallback: T,
	sanitize?: (layout: T) => T,
) {
	const [layout, setLayout] = useState<T>(() => readStoredLayout(key, fallback, sanitize))

	useEffect(() => {
		if (typeof window === 'undefined') return
		try {
			window.localStorage.setItem(key, JSON.stringify(layout))
		} catch {}
	}, [key, layout])

	return [layout, setLayout] as const
}
