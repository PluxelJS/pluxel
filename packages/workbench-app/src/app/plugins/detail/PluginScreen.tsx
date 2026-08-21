import { Skeleton, useMantineTheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { useDebouncedFlag } from '../../../hooks'
import {
	type PluginDependency,
	type PluginStatusEntry,
	PluginStatusEntryLifecycleStage,
	useQuery,
} from '../../gqlens'
import { usePluginConfig } from '../config/usePluginConfig'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { materializeAddress, usePluginOverview } from '../pluginOverview'
import { PluginScopeProvider, type PluginSourceKind } from './context'
import { PluginWorkbench } from './workbench/PluginWorkbench'
import { WorkbenchTargetProvider } from '../../../workbench/runtime'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'

function PluginSkeleton({ stacked }: { stacked: boolean }) {
	return (
		<div className="plx-pluginSkeleton" data-stacked={stacked ? 'true' : 'false'}>
			<div className="plx-pluginSkeleton__header">
				<div className="plx-pluginSkeleton__title">
					<Skeleton height={20} width={180} radius="sm" />
					<div className="plx-pluginSkeleton__chips">
						<Skeleton height={22} width={72} radius="xl" />
						<Skeleton height={22} width={92} radius="xl" />
						<Skeleton height={22} width={108} radius="xl" />
					</div>
					<Skeleton height={12} width="44%" />
				</div>
				<div className="plx-pluginSkeleton__actions">
					<Skeleton height={28} width={96} radius="sm" />
					<Skeleton height={28} width={84} radius="sm" />
					<Skeleton height={28} width={116} radius="sm" />
				</div>
			</div>

			<div className="plx-pluginSkeleton__tabs">
				<Skeleton height={28} width={72} radius="sm" />
				<Skeleton height={28} width={88} radius="sm" />
				<Skeleton height={28} width={76} radius="sm" />
				<Skeleton height={28} width={98} radius="sm" />
			</div>

			<div className="plx-pluginSkeleton__body">
				<div className="plx-pluginSkeleton__workspace">
					<div className="plx-pluginSkeleton__workspaceHead">
						<Skeleton height={14} width="28%" />
						<Skeleton height={14} width="18%" />
					</div>
					<Skeleton height="100%" radius="lg" />
				</div>

				<div className="plx-pluginSkeleton__aside">
					<div className="plx-pluginSkeleton__asideHead">
						<Skeleton height={20} width={92} radius="sm" />
						<Skeleton height={20} width={56} radius="xl" />
					</div>
					<Skeleton height={96} radius="sm" />
					<Skeleton height={132} radius="sm" />
					<Skeleton height="100%" radius="sm" />
				</div>
			</div>

			<div className="plx-pluginSkeleton__dock">
				<div className="plx-pluginSkeleton__dockTabs">
					<Skeleton height={24} width={78} radius="sm" />
					<Skeleton height={24} width={66} radius="sm" />
				</div>
				<Skeleton height="100%" radius="lg" />
			</div>
		</div>
	)
}

export interface PluginScreenProps {
	pluginName: string
}

type PluginDetailView = {
	id: string
	address: PluginNodeAddressSnapshot
	rootExportName: string
	name: string
	desc: string
	dependencies: PluginDependency[]
}

type PluginStatusSnapshot = {
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: PluginStatusEntryLifecycleStage
	source: NonNullable<PluginStatusEntry['source']> | null
}

const EMPTY_STATUS_ENTRIES: PluginStatusEntry[] = []

function clonePluginDetailView(detail: PluginDetailView): PluginDetailView {
	return {
		...detail,
		dependencies: Array.isArray(detail.dependencies) ? [...detail.dependencies] : [],
	}
}

function resolveLifecycleStage(
	isEnabled: boolean,
	isRunning: boolean,
	lifecycleStage?: PluginStatusEntryLifecycleStage | null,
) {
	if (lifecycleStage) return lifecycleStage
	if (isEnabled) {
		return isRunning
			? PluginStatusEntryLifecycleStage.running
			: PluginStatusEntryLifecycleStage.stopped
	}
	return PluginStatusEntryLifecycleStage.disabled
}

function resolveStatusSnapshot(statusEntry: PluginStatusEntry | null): PluginStatusSnapshot | null {
	if (!statusEntry) return null
	const isEnabled = statusEntry.isEnabled !== false
	const isRunning = Boolean(statusEntry.isRunning)
	return {
		isRunning,
		isEnabled,
		lifecycleStage: resolveLifecycleStage(isEnabled, isRunning, statusEntry.lifecycleStage),
		source: statusEntry.source ?? null,
	}
}

function resolvePluginSource(snapshot: PluginStatusSnapshot | null): {
	kind: PluginSourceKind
	moduleId: string | null
	packageName: string | null
	version: string | null
	tag: string | null
} {
	const rawSource = snapshot?.source ?? null
	return {
		kind: (rawSource?.kind ?? 'unknown') as PluginSourceKind,
		moduleId: rawSource?.moduleId ?? null,
		packageName: rawSource?.packageName ?? null,
		version: rawSource?.version ?? null,
		tag: rawSource?.tag ?? null,
	}
}

function resolveVisibleDependencies(params: {
	rawDeps?: PluginDependency[]
	stableDeps: PluginDependency[]
	syncing: boolean
}) {
	const { rawDeps, stableDeps, syncing } = params
	const preferStableDeps = Boolean(
		rawDeps && Array.isArray(rawDeps) && rawDeps.length === 0 && stableDeps.length > 0,
	)
	return syncing && preferStableDeps ? stableDeps : (rawDeps ?? stableDeps)
}

function usePluginDetail(pluginName?: string) {
	// Reuse the global overview snapshot to avoid duplicate status requests on plugin pages.
	const overviewState = usePluginOverview()
	const statusEntries = overviewState.overview?.status?.statuses ?? EMPTY_STATUS_ENTRIES
	const refetchOverview = overviewState.refetch

	const statusMap = useMemo(() => {
		const map = new Map<string, PluginStatusEntry>()
		for (const entry of statusEntries) {
			if (entry?.id) map.set(entry.id, entry)
		}
		return map
	}, [statusEntries])

	const statusEntry = useMemo(() => {
		if (!pluginName) return null
		return statusMap.get(pluginName) ?? null
	}, [pluginName, statusMap])

	const listed = useMemo(() => {
		if (!pluginName) return false
		return statusMap.has(pluginName)
	}, [pluginName, statusMap])

	// Always request detail; we handle missing plugins via stable UI decisions instead of gating.
	const detailQuery = useQuery({
		policy: 'cache-first',
		ttl: 30_000,
	})

	let scope: ReturnType<(typeof detailQuery.pluginCatalog)['plugin']> | undefined
	let dependencies: PluginDependency[] = []
	let dependenciesReady = true
	if (pluginName !== undefined) {
		try {
			const catalog = detailQuery.pluginCatalog
			scope = catalog.plugin({ id: pluginName })
			dependencies = (scope.detail.dependencies.ids ?? []).flatMap((id) => {
				const dep = catalog.plugin({ id })
				const address = materializeAddress(dep.address)
				if (!address) {
					dependenciesReady = false
					return []
				}
				return [
					{
						id: dep.id ?? id,
						name: dep.name ?? id,
						rootExportName: dep.rootExportName ?? '',
						address,
						isRunning: Boolean(dep.status.isRunning),
					},
				]
			})
		} catch (error) {
			if (process.env.NODE_ENV !== 'production') {
				console.warn('[PluginScreen] Failed to read plugin scope', error)
			}
			scope = undefined
		}
	}

	const address = scope ? materializeAddress(scope.address) : null
	const detail =
		scope?.name && address && dependenciesReady
			? {
					id: scope.id ?? pluginName ?? '',
					address,
					rootExportName: scope.rootExportName ?? '',
					name: scope.name,
					desc: scope.detail?.desc ?? '',
					dependencies,
				}
			: undefined
	const ready = Boolean(detail?.name)
	const loading = Boolean(detailQuery.loading)
	const error = detailQuery.error

	const refetch = useCallback(async () => {
		detailQuery.refetch()
		refetchOverview()
	}, [detailQuery, refetchOverview])

	return {
		detail,
		ready,
		listed,
		hasStatusSnapshot: overviewState.hasSnapshot,
		statusEntry,
		error,
		loading,
		refetch,
	}
}

export const PluginScreen = memo(function PluginScreen({ pluginName }: PluginScreenProps) {
	const theme = useMantineTheme()
	// 更早进入纵向堆叠，确保右侧配置区域在窄屏下可读
	const isStackedWide = useMediaQuery('(max-width: 1500px)', false, {
		getInitialValueInEffect: true,
	})
	const isStackedBreak = useMediaQuery(
		`(max-width: ${
			typeof theme.breakpoints?.lg === 'number'
				? `${theme.breakpoints.lg}px`
				: (theme.breakpoints?.lg ?? '62em')
		})`,
		false,
		{
			getInitialValueInEffect: true,
		},
	)
	const isStacked = isStackedWide || isStackedBreak

	const { detail, ready, listed, hasStatusSnapshot, statusEntry, error, loading, refetch } =
		usePluginDetail(pluginName)
	const pathname = useCurrentPathname()

	// 稳定快照：refetch/同步期间，详情查询可能短暂返回空字段，导致 UI “0 依赖/空注入卡片”闪一下。
	// 这里缓存上一份成功读取到的 detail，用于过渡期展示。
	const lastStableRef = useRef<PluginDetailView | null>(null)

	useEffect(() => {
		if (!detail?.name) {
			lastStableRef.current = null
			return
		}
		lastStableRef.current = clonePluginDetailView(detail)
	}, [detail])

	const stable = lastStableRef.current?.id === pluginName ? lastStableRef.current : null
	const viewReady = ready || Boolean(stable?.name)
	const displayName = detail?.name ?? stable?.name ?? pluginName
	const description = detail?.desc ?? stable?.desc ?? ''
	const statusRef = useRef<PluginStatusSnapshot | null>(null)
	const statusEntryRef = useRef<PluginStatusEntry | null>(null)
	const [statusOverride, setStatusOverride] = useState<{
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: PluginStatusEntryLifecycleStage
	} | null>(null)

	useEffect(() => {
		statusRef.current = null
		statusEntryRef.current = null
		setStatusOverride(null)
	}, [pluginName])

	const resolvedStatus = useMemo(() => resolveStatusSnapshot(statusEntry), [statusEntry])

	useEffect(() => {
		if (resolvedStatus) statusRef.current = resolvedStatus
	}, [resolvedStatus])

	useEffect(() => {
		if (statusEntry) statusEntryRef.current = statusEntry
	}, [statusEntry])

	useEffect(() => {
		if (resolvedStatus) setStatusOverride(null)
	}, [resolvedStatus])

	const effectiveStatus = statusOverride ?? resolvedStatus ?? statusRef.current
	const effectiveStatusEntry = statusEntry ?? statusEntryRef.current ?? null
	const isRunning = Boolean(effectiveStatus?.isRunning)
	const isEnabled = effectiveStatus?.isEnabled ?? true
	const lifecycleStage = resolveLifecycleStage(
		isEnabled,
		isRunning,
		effectiveStatus?.lifecycleStage,
	)

	const owner = detail?.address ?? stable?.address ?? statusEntry?.address
	const configState = usePluginConfig(viewReady ? owner : undefined, displayName)
	const syncing = useDebouncedFlag(loading || configState.loading, 160)

	const rawDeps = detail?.dependencies
	const stableDeps = stable?.dependencies ?? []
	const dependencies = resolveVisibleDependencies({ rawDeps, stableDeps, syncing })

	const handleRefetch = useCallback(async () => {
		await refetch()
	}, [refetch])

	const handleStatusOverride = useCallback(
		(next: {
			isRunning: boolean
			isEnabled: boolean
			lifecycleStage: PluginStatusEntryLifecycleStage
		}) => {
			setStatusOverride(next)
		},
		[],
	)

	const contextValue = useMemo(() => {
		if ((!detail && !stable) || !owner) return null
		return {
			owner,
			pluginId: pluginName,
			pluginName: displayName,
			description,
			dependencies,
			status: effectiveStatusEntry,
			isRunning,
			isSyncing: syncing,
			isEnabled,
			lifecycleStage,
			source: resolvePluginSource(resolvedStatus ?? statusRef.current),
			refetch: handleRefetch,
			setStatusOverride: handleStatusOverride,
		}
	}, [
		dependencies,
		description,
		displayName,
		owner,
		pluginName,
		handleRefetch,
		handleStatusOverride,
		effectiveStatusEntry,
		isRunning,
		isEnabled,
		lifecycleStage,
		detail,
		resolvedStatus,
		stable,
		syncing,
	])

	if (!pluginName) {
		return (
			<EmptyState
				icon={<IconPuzzle size={28} stroke={1.5} />}
				title="请选择一个插件"
				description="从左侧列表选择插件以查看详情。"
				minHeight="100%"
			/>
		)
	}

	// Not found: only decide when we have a status snapshot AND the detail request errored.
	if (pluginName && hasStatusSnapshot && !listed && Boolean(error) && !loading) {
		return (
			<EmptyState
				icon={<IconPuzzle size={28} stroke={1.5} />}
				title="插件不存在"
				description={`未找到插件：${pluginName}`}
				minHeight="100%"
			/>
		)
	}

	if (error && !ready) {
		return (
			<ErrorState
				title="加载失败"
				message={error.message || '无法加载插件详情，请重试'}
				onRetry={() => void refetch()}
				minHeight="100%"
			/>
		)
	}

	if (!viewReady) return <PluginSkeleton stacked={Boolean(isStacked)} />
	if (!contextValue) return null

	return (
		<WorkbenchTargetProvider target={contextValue.owner} pathname={pathname}>
			<PluginScopeProvider value={contextValue}>
				<PluginWorkbench config={configState} />
			</PluginScopeProvider>
		</WorkbenchTargetProvider>
	)
})
