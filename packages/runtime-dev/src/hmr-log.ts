export type HmrPluginTotals = {
	loaded: number
	enabled: number
	running: number
}

export type HmrInvalidationCounts = {
	vite: number
	runner: number
}

export type HmrHotspot = {
	id: string
	ms: number
}

export type HmrUpdatedLogProps = {
	epoch?: number
	changedFiles: number
	changedPreview?: readonly string[]
	changedPreviewOmitted?: number
	targets: number
	affectedModules?: number
	syncedModules?: number
	autoDisabled?: readonly string[]
	enabledButStopped?: readonly string[]
	affected: number
	fallbackRoots: number
	activeServices: number
	plugins: HmrPluginTotals
	hotspots?: readonly HmrHotspot[]
	invalidated: HmrInvalidationCounts
	prefetchFailed?: number
	commitMs: number | null
	batchMs?: number | null
	ok: boolean
	commitError?: string
	executeError?: string
	injectError?: string
}

export type HmrReportScope = {
	anchors: number
	entries: number
	roots: number
}

export type HmrReportReason = 'startup' | 'update' | 'warmup'

export type HmrReportRoot = {
	root: string
	entries: number
	plugins?: HmrPluginTotals
}

export type HmrPluginsByRootMode = 'byRoot' | 'partial' | 'off'

export type HmrPluginsByRootReason =
	| 'ok'
	| 'unresolved-moduleIds'
	| 'unmapped-moduleIds'
	| 'resolve-capped'
	| 'all-unresolved'

export type HmrPluginsByRootInfo =
	| {
			mode: 'byRoot'
			reasons: ['ok']
	  }
	| {
			mode: 'partial' | 'off'
			reasons: readonly HmrPluginsByRootReason[]
			unresolved: number
			unmapped: number
			resolvedSpecifiers: number
			resolveAttempts: number
			resolveLimit: number
	  }

export type HmrReportLogProps = {
	reason: HmrReportReason
	scope: HmrReportScope
	roots: readonly HmrReportRoot[]
	plugins: HmrPluginTotals
	pluginsByRoot?: HmrPluginsByRootInfo
	hotspots?: readonly HmrHotspot[]
	loaded?: readonly string[]
	entries?: readonly string[]
	commit?: unknown
}

export const HMR_CHANGED_PREVIEW_LIMIT = 3
export const HMR_PATH_PREVIEW_LIMIT = 12

export function roundHmrMs(ms: number): number {
	return Math.round(ms * 10) / 10
}

export function takeHmrPreview<T>(
	items: readonly T[],
	limit: number,
): {
	preview: T[]
	omitted: number
} {
	const preview = items.slice(0, Math.max(0, limit))
	return {
		preview,
		omitted: Math.max(0, items.length - preview.length),
	}
}

export function hmrOptionalCount(value: number): number | undefined {
	return value > 0 ? value : undefined
}

export function hmrOptionalList<T>(items: readonly T[]): readonly T[] | undefined {
	return items.length > 0 ? items : undefined
}

export function hmrChangedPreviewProps(
	items: readonly string[],
	limit = HMR_CHANGED_PREVIEW_LIMIT,
): Pick<HmrUpdatedLogProps, 'changedPreview' | 'changedPreviewOmitted'> {
	const { preview, omitted } = takeHmrPreview(items, limit)
	return {
		changedPreview: hmrOptionalList(preview),
		changedPreviewOmitted: hmrOptionalCount(omitted),
	}
}

export function hmrInvalidated(vite: number, runner = 0): HmrInvalidationCounts {
	return { vite, runner }
}

export function hmrPathPreview(
	paths: Iterable<string>,
	options: {
		limit?: number
		normalize?: (path: string) => string
	} = {},
): string[] {
	const limit = Math.max(0, options.limit ?? HMR_PATH_PREVIEW_LIMIT)
	const normalize = options.normalize ?? ((path: string) => path)
	const out: string[] = []
	for (const path of paths) {
		const normalized = normalize(path)
		if (normalized.startsWith('\0')) continue
		out.push(normalized)
		if (out.length >= limit) break
	}
	return out
}
