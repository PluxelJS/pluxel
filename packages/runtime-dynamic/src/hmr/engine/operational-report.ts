import { fileURLToPath } from 'node:url'
import type { Logger as LogtapeLogger } from '@logtape/logtape'
import type { PluginNodeAddress } from '@pluxel/core'
import { resolve } from 'pathe'
import { normalizePath } from 'vite'
import { DRIVE_PATH_RE, fsPathFromViteFsId, resolveCacheLimit } from '@pluxel/runtime/internal'
import type {
	HmrPluginTotals as PluginTotals,
	HmrPluginsByRootInfo as PluginsByRootInfo,
	HmrPluginsByRootMode as PluginsByRootMode,
	HmrPluginsByRootReason as PluginsByRootReason,
	HmrReportLogProps as HmrOperationalReportProps,
	HmrReportReason,
	HmrReportRoot,
} from '@pluxel/runtime-dev/hmr-log'

export type RegistryViewLike = {
	listRegistered: () => readonly {
		address: PluginNodeAddress
	}[]
	findModuleId: (address: PluginNodeAddress) => string | null
}

const FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|json)$/i

function isLikelyFileModuleId(moduleId: string) {
	if (!moduleId) return false
	if (moduleId.startsWith('\0')) return false
	if (moduleId.includes('?')) return false
	if (moduleId.startsWith('file://')) return true
	if (moduleId.startsWith('/@fs/')) return true
	if (moduleId.startsWith('/@')) return false
	if (DRIVE_PATH_RE.test(moduleId)) return true
	if (moduleId.startsWith('/')) return true
	if (moduleId.startsWith('.')) return true
	if (FILE_EXT_RE.test(moduleId)) return true
	return false
}

function normalizeModuleIdToFsPath(cwd: string, moduleId: string) {
	if (moduleId.startsWith('file://')) {
		try {
			return normalizePath(fileURLToPath(moduleId))
		} catch {
			// fall through
		}
	}
	if (moduleId.startsWith('/@fs/')) {
		const fsPath = fsPathFromViteFsId(moduleId)
		return fsPath ? normalizePath(fsPath) : normalizePath(moduleId.slice('/@fs'.length))
	}
	if (DRIVE_PATH_RE.test(moduleId)) return normalizePath(moduleId)
	if (moduleId.startsWith('/')) return normalizePath(moduleId)
	// Host-relative (do NOT resolve against Vite server root).
	return normalizePath(resolve(cwd, moduleId))
}

export function collectPluginTotals(params: {
	registryView: RegistryViewLike
	isPluginDesired: (address: PluginNodeAddress) => boolean
	isRunning: (address: PluginNodeAddress) => boolean
}): PluginTotals {
	const plugins: PluginTotals = { loaded: 0, desired: 0, running: 0 }

	for (const entry of params.registryView.listRegistered()) {
		const desired = params.isPluginDesired(entry.address)
		const running = params.isRunning(entry.address)
		plugins.loaded++
		if (desired) plugins.desired++
		if (running) plugins.running++
	}

	return plugins
}

export async function buildHmrOperationalReport(params: {
	reason: HmrReportReason
	cwd: string
	anchors: number
	entries: number
	rootsAbs: readonly string[]
	rootsPretty: readonly string[]
	entriesByRoot: readonly number[]
	registryView: RegistryViewLike
	isPluginDesired: (address: PluginNodeAddress) => boolean
	isRunning: (address: PluginNodeAddress) => boolean
	resolveBareWorkspaceEntry: (specifier: string) => Promise<string | null>
	resolveLimit?: number
	hotspots?: Array<{ id: string; ms: number }>
	dbg?: LogtapeLogger
}): Promise<HmrOperationalReportProps> {
	const resolveLimit = resolveCacheLimit(params.resolveLimit, 50)

	const rootsAbs = params.rootsAbs
	const rootsPretty = params.rootsPretty

	const isUnder = (child: string, root: string) =>
		child === root || child.startsWith(root.endsWith('/') ? root : `${root}/`)

	const loadedByRoot = Array<number>(rootsAbs.length).fill(0)
	const desiredByRoot = Array<number>(rootsAbs.length).fill(0)
	const runningByRoot = Array<number>(rootsAbs.length).fill(0)

	const pluginTotals = collectPluginTotals({
		registryView: params.registryView,
		isPluginDesired: params.isPluginDesired,
		isRunning: params.isRunning,
	})

	const stats = {
		unresolved: 0,
		unmapped: 0,
		resolvedSpecifiers: 0,
		resolveAttempts: 0,
		resolveLimit,
	}

	const resolveCache = new Map<string, Promise<string | null>>()

	const resolveModuleIdForRootGrouping = async (moduleId: string): Promise<string | null> => {
		if (isLikelyFileModuleId(moduleId)) return normalizeModuleIdToFsPath(params.cwd, moduleId)

		// Best-effort: resolve bare specifiers to workspace entry sources.
		if (stats.resolveAttempts >= stats.resolveLimit) return null

		const cached = resolveCache.get(moduleId)
		if (cached) return await cached

		stats.resolveAttempts++
		const p = params
			.resolveBareWorkspaceEntry(moduleId)
			.catch((): null => null)
			.then((resolved) => {
				if (!resolved) return null
				stats.resolvedSpecifiers++
				return normalizeModuleIdToFsPath(params.cwd, resolved)
			})
		resolveCache.set(moduleId, p)
		return await p
	}

	for (const entry of params.registryView.listRegistered()) {
		const moduleId = params.registryView.findModuleId(entry.address)
		if (!moduleId) continue

		const desired = params.isPluginDesired(entry.address)
		const running = params.isRunning(entry.address)

		const clean = await resolveModuleIdForRootGrouping(moduleId)
		if (!clean) {
			stats.unresolved++
			continue
		}

		let matched = false
		for (let i = 0; i < rootsAbs.length; i++) {
			if (!isUnder(clean, rootsAbs[i]!)) continue
			loadedByRoot[i] = (loadedByRoot[i] ?? 0) + 1
			if (desired) desiredByRoot[i] = (desiredByRoot[i] ?? 0) + 1
			if (running) runningByRoot[i] = (runningByRoot[i] ?? 0) + 1
			matched = true
			break
		}
		if (!matched) stats.unmapped++
	}

	const reasons: PluginsByRootReason[] = []
	if (stats.resolveAttempts >= stats.resolveLimit && stats.unresolved > 0)
		reasons.push('resolve-capped')
	if (stats.unresolved > 0) reasons.push('unresolved-moduleIds')
	if (stats.unmapped > 0) reasons.push('unmapped-moduleIds')

	let mode: PluginsByRootMode = 'byRoot'
	if (pluginTotals.loaded > 0 && loadedByRoot.every((n) => n === 0) && stats.unresolved > 0) {
		mode = 'off'
		reasons.unshift('all-unresolved')
	} else if (reasons.length > 0) {
		mode = 'partial'
	}
	if (reasons.length === 0) reasons.push('ok')

	const pluginsByRoot: PluginsByRootInfo =
		mode === 'byRoot'
			? { mode: 'byRoot', reasons: ['ok'] }
			: {
					mode,
					reasons,
					unresolved: stats.unresolved,
					unmapped: stats.unmapped,
					resolvedSpecifiers: stats.resolvedSpecifiers,
					resolveAttempts: stats.resolveAttempts,
					resolveLimit: stats.resolveLimit,
				}

	const roots: HmrReportRoot[] = rootsPretty.map((root, i) => {
		const base = { root, entries: params.entriesByRoot[i] ?? 0 }
		if (mode === 'off') return base
		return {
			...base,
			plugins: {
				loaded: loadedByRoot[i] ?? 0,
				desired: desiredByRoot[i] ?? 0,
				running: runningByRoot[i] ?? 0,
			},
		}
	})

	if (params.dbg && mode !== 'byRoot') {
		params.dbg.debug(
			(l) =>
				l`HMR report pluginsByRoot=${mode} unresolved=${stats.unresolved} unmapped=${stats.unmapped} resolves=${stats.resolveAttempts}/${stats.resolveLimit}`,
		)
	}

	return {
		reason: params.reason,
		scope: { anchors: params.anchors, entries: params.entries, roots: rootsPretty.length },
		roots,
		plugins: pluginTotals,
		pluginsByRoot,
		hotspots: params.hotspots,
	}
}
