import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { SplitViewHandle, SplitViewLayout } from './view'

type NumericLayout = Record<string, number>
type BooleanState = Record<string, boolean | undefined>

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function resolveLayoutValue<T extends NumericLayout>(
	value: unknown,
	fallback: T,
	sanitize?: (layout: T) => T,
): T {
	if (!isRecord(value)) return fallback
	const next = { ...fallback }
	for (const id of Object.keys(fallback)) {
		if (typeof value[id] === 'number') {
			next[id as keyof T] = value[id] as T[keyof T]
		}
	}
	return sanitize ? sanitize(next) : next
}

export function sanitizeOptionalBooleanState<T extends BooleanState>(
	value: unknown,
	keys: Array<keyof T>,
): Partial<T> {
	if (!isRecord(value)) return {}
	const next: Partial<T> = {}
	for (const key of keys) {
		const recordKey = String(key)
		if (typeof value[recordKey] === 'boolean') {
			next[key] = value[recordKey] as T[keyof T]
		}
	}
	return next
}

export function hasSameLayout<T extends NumericLayout>(left: T, right: T) {
	const keys = Object.keys(left)
	if (keys.length !== Object.keys(right).length) return false
	return keys.every((key) => Math.abs((left[key] ?? 0) - (right[key] ?? 0)) < 0.01)
}

export function mergeLayout<T extends NumericLayout>(
	current: T,
	next: Record<string, number>,
	sanitize?: (layout: T) => T,
): T {
	const merged = { ...current }
	for (const key of Object.keys(current)) {
		const nextValue = next[key]
		if (typeof nextValue === 'number') {
			merged[key as keyof T] = nextValue as T[keyof T]
		}
	}
	return sanitize ? sanitize(merged) : merged
}

/** Normalizes a two-pane percentage layout and enforces the supplied minimum percentages. */
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
		return resolveLayoutValue(JSON.parse(raw), fallback, sanitize)
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

/**
 * Owns a sanitized percentage layout in localStorage. Pass the returned callback to a split
 * view's commit event; calling it directly also persists the supplied layout.
 */
export function useStoredSplitLayout<T extends NumericLayout>(
	key: string,
	fallback: T,
	sanitize: (layout: T) => T,
) {
	const [layout, setLayout] = useStoredLayout(key, fallback, sanitize)

	const handleLayoutChanged = useCallback(
		(nextLayout: SplitViewLayout) => {
			setLayout((current) => mergeLayout(current, nextLayout, sanitize))
		},
		[sanitize, setLayout],
	)

	return [layout, handleLayoutChanged] as const
}

export function useSyncedLayout<T extends NumericLayout>(
	groupRef: RefObject<SplitViewHandle | null>,
	layout: T,
	enabled = true,
) {
	useEffect(() => {
		if (!enabled) return
		const current = groupRef.current?.getLayout()
		if (!current || !hasSameLayout(current as T, layout)) {
			groupRef.current?.setLayout(layout)
		}
	}, [enabled, groupRef, layout])
}
