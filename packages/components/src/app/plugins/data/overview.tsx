import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import {
	PluginSourceInfoKind,
	PluginStatusEntryLifecycleStage,
	type PluginGroup,
	type PluginStatusOverview,
} from '../../gqty'
import { useQuery } from '../../gqty'
import { subscribeInvalidations } from '../../data/invalidations'

type PluginOverview = {
	status: PluginStatusOverview
	groups: PluginGroup[]
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

export function setPluginOverviewGroups(groups: PluginGroup[]) {
	const prev = snapshot.current
	if (!prev.overview) return
	applyOverview({
		...prev.overview,
		groups: groups.map((group) => ({
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

function normalizeStatusOverview(input: any): PluginStatusOverview {
	const rawSummary = input?.summary ?? {}
	return {
		statuses: (input?.statuses ?? [])
			.filter(Boolean)
			.map((entry: any) => ({
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
		groupId: group?.groupId ?? '',
		name: group?.name ?? '',
		pluginIds: Array.isArray(group?.pluginIds) ? group.pluginIds.map(String) : [],
	}))
}

export function PluginOverviewProvider({ children }: { children?: ReactNode }) {
	const query = useQuery({
		suspense: false,
		operationName: 'PluginOverview',
		notifyOnNetworkStatusChange: false,
		refetchOnReconnect: false,
		refetchOnWindowVisible: false,
		fetchInBackground: true,
		prepare: ({ query }) => {
			const status = query.pluginStatus
			status.summary.total
			status.summary.running
			status.summary.stopped
			status.summary.disabled
			status.statuses.forEach((entry) => {
				entry.name
				entry.isRunning
				entry.isEnabled
				entry.lifecycleStage
				const source = entry.source
				source.kind
				source.moduleId
				source.packageName
				source.version
				source.tag
			})
			query.pluginGroups.forEach((group) => {
				group.groupId
				group.name
				group.pluginIds
			})
		},
	})

	const isLoading = query.$state.isLoading === true
	const error = query.$state.error

	useEffect(() => {
		setLoading(isLoading)
	}, [isLoading])

	useEffect(() => {
		setError(error?.message)
	}, [error])

	const overview = useMemo<PluginOverview | null>(() => {
		try {
			return {
				status: normalizeStatusOverview(query.pluginStatus),
				groups: normalizeGroups(query.pluginGroups),
			}
		} catch {
			return null
		}
	}, [query.pluginGroups, query.pluginStatus])

	useEffect(() => {
		if (isLoading || error || !overview) return
		applyOverview(overview)
	}, [overview, isLoading, error])

	useEffect(() => {
		const refetchOverview = async (): Promise<void> => {
			await query.$refetch(true)
		}
		registerPluginOverviewRefetcher(
			refetchOverview,
		)
		return (): void => {
			registerPluginOverviewRefetcher(null)
		}
	}, [query.$refetch])

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
			void query
				.$refetch(true)
				.catch(() => {})
				.finally(() => {
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
	}, [error, query.$refetch])

	return <>{children}</>
}
