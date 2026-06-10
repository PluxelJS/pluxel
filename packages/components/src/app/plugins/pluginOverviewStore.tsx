import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import {
	PluginSourceInfoKind,
	PluginStatusEntryLifecycleStage,
	useQuery,
	type PluginGroup,
	type PluginStatusOverview,
	type PluginStatusEntry,
} from '../gqlens'
import { subscribeInvalidations } from '../data/invalidations'

type PluginStatusOverviewView = Omit<PluginStatusOverview, 'plugins'> & {
	statuses: PluginStatusEntry[]
}

type PluginOverview = {
	status: PluginStatusOverviewView
	groups: PluginGroup[]
}

type PluginGroupSnapshot = Pick<PluginGroup, 'groupId' | 'name' | 'pluginIds'> & {
	id?: string
}

export type PluginOverviewSnapshot = Readonly<{
	hasSnapshot: boolean
	signature: string
	overview: PluginOverview | null
	isLoading: boolean
	error?: string
}>

type Refetcher = () => Promise<void>

const listeners = new Set<() => void>()
let refetcher: Refetcher | null = null

const snapshot: { current: PluginOverviewSnapshot } = {
	current: {
		hasSnapshot: false,
		signature: '',
		overview: null,
		isLoading: false,
		error: undefined,
	},
}

function emit() {
	for (const listener of listeners) listener()
}

function buildSignature(overview: PluginOverview): string {
	const status = overview.status
	const summary = status.summary
	const statusParts = [...(status.statuses ?? [])]
		.filter((entry) => entry && typeof entry.name === 'string')
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(
			(entry) =>
				`${entry.name}:${entry.isRunning ? 1 : 0}:${entry.isEnabled ? 1 : 0}:${entry.lifecycleStage}`,
		)
	const groupParts = [...(overview.groups ?? [])]
		.filter((group) => group && typeof group.groupId === 'string')
		.sort((a, b) => a.groupId.localeCompare(b.groupId))
		.map((group) => `${group.groupId}:${group.name}:${group.pluginIds.join(',')}`)
	return [
		`summary:${summary.total}:${summary.running}:${summary.stopped}:${summary.disabled}`,
		`statuses:${statusParts.join('|')}`,
		`groups:${groupParts.join('|')}`,
	].join('||')
}

function setSnapshot(next: PluginOverviewSnapshot) {
	const prev = snapshot.current
	const changed =
		prev.hasSnapshot !== next.hasSnapshot ||
		prev.signature !== next.signature ||
		prev.isLoading !== next.isLoading ||
		prev.error !== next.error
	if (!changed) return
	snapshot.current = next
	emit()
}

function applyOverview(overview: PluginOverview) {
	const signature = buildSignature(overview)
	const prev = snapshot.current
	if (prev.hasSnapshot && prev.signature === signature) {
		setSnapshot({ ...prev, isLoading: false, error: undefined })
		return
	}
	setSnapshot({
		hasSnapshot: true,
		signature,
		overview,
		isLoading: false,
		error: undefined,
	})
}

function setLoading(isLoading: boolean) {
	const prev = snapshot.current
	if (prev.hasSnapshot && isLoading) return
	if (prev.isLoading === isLoading) return
	setSnapshot({ ...prev, isLoading })
}

function setError(error?: string) {
	const prev = snapshot.current
	if (prev.error === error) return
	setSnapshot({ ...prev, error, isLoading: false })
}

export function registerPluginOverviewRefetcher(next: Refetcher | null) {
	refetcher = next
}

export function requestPluginOverviewRefetch() {
	return refetcher?.()
}

export function setPluginOverviewGroups(groups: PluginGroupSnapshot[]) {
	const prev = snapshot.current
	if (!prev.overview) return
	applyOverview({
		...prev.overview,
		groups: groups.map((group) => ({
			id: group.id ?? group.groupId,
			groupId: group.groupId,
			name: group.name,
			pluginIds: [...group.pluginIds],
		})),
	})
}

export function getPluginOverviewSnapshot(): PluginOverviewSnapshot {
	return snapshot.current
}

export function usePluginOverview(): PluginOverviewSnapshot {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		getPluginOverviewSnapshot,
		getPluginOverviewSnapshot,
	)
}

function normalizeStatusOverview(input: any): PluginStatusOverviewView {
	const rawSummary = input?.summary ?? {}
	return {
		statuses: (input?.statuses ?? []).filter(Boolean).map((entry: any) => ({
			id: entry?.id ?? entry?.name ?? '',
			name: entry?.name ?? '',
			isRunning: Boolean(entry?.isRunning),
			isEnabled: entry?.isEnabled !== false,
			lifecycleStage: entry?.lifecycleStage ?? PluginStatusEntryLifecycleStage.stopped,
			source: {
				kind: entry?.source?.kind ?? PluginSourceInfoKind.unknown,
				moduleId: entry?.source?.moduleId ?? null,
				packageName: entry?.source?.packageName ?? null,
				version: entry?.source?.version ?? null,
				tag: entry?.source?.tag ?? null,
			},
		})),
		summary: {
			total: Number(rawSummary?.total ?? 0),
			running: Number(rawSummary?.running ?? 0),
			stopped: Number(rawSummary?.stopped ?? 0),
			disabled: Number(rawSummary?.disabled ?? 0),
		},
	}
}

function normalizeGroups(groups: any): PluginGroup[] {
	return (groups ?? []).map((group: any) => ({
		id: group?.id ?? group?.groupId ?? '',
		groupId: group?.groupId ?? '',
		name: group?.name ?? '',
		pluginIds: Array.isArray(group?.pluginIds) ? group.pluginIds.map(String) : [],
	}))
}

export function PluginOverviewProvider({ children }: { children?: ReactNode }) {
	const query = useQuery({
		policy: 'cache-first',
		ttl: 30_000,
	})

	const isLoading = query.loading
	const error = query.error

	useEffect(() => {
		setLoading(isLoading)
	}, [isLoading])

	useEffect(() => {
		setError(error?.message)
	}, [error])

	const overview = useMemo<PluginOverview | null>(() => {
		try {
			const catalog = query.pluginCatalog
			const status = catalog.status
			const statusEntries = (status.plugins.ids ?? []).map((id) => {
				const plugin = catalog.plugin({ id })
				return {
					id: plugin.id ?? id,
					name: plugin.name ?? id,
					isRunning: Boolean(plugin.status.isRunning),
					isEnabled: plugin.status.isEnabled !== false,
					lifecycleStage: plugin.status.lifecycleStage ?? PluginStatusEntryLifecycleStage.stopped,
					source: {
						kind: plugin.status.source.kind ?? PluginSourceInfoKind.unknown,
						moduleId: plugin.status.source.moduleId ?? null,
						packageName: plugin.status.source.packageName ?? null,
						version: plugin.status.source.version ?? null,
						tag: plugin.status.source.tag ?? null,
					},
				}
			})
			const groups = (catalog.groups.ids ?? []).map((id) => catalog.group({ id }))
			return {
				status: normalizeStatusOverview({
					statuses: statusEntries,
					summary: status.summary,
				}),
				groups: normalizeGroups(groups),
			}
		} catch {
			return null
		}
	}, [query])

	useEffect(() => {
		if (isLoading || error || !overview) return
		applyOverview(overview)
	}, [overview, isLoading, error])

	useEffect(() => {
		const refetchOverview = async (): Promise<void> => {
			query.refetch()
		}
		registerPluginOverviewRefetcher(refetchOverview)
		return (): void => {
			registerPluginOverviewRefetcher(null)
		}
	}, [query])

	useEffect(() => {
		let inflight = false
		let pending = false
		const handle = (): void => {
			if (error) return
			if (inflight) {
				pending = true
				return
			}
			inflight = true
			query.refetch()
			queueMicrotask(() => {
				inflight = false
				if (pending) {
					pending = false
					handle()
				}
			})
		}
		return subscribeInvalidations((event) => {
			if (event.topic !== 'plugin-status' && event.topic !== 'plugin-groups') return
			handle()
		})
	}, [error, query])

	return <>{children}</>
}
