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
	usePluginOverview,
} from '../pluginOverview'
import { usePluginConfig } from '../config/usePluginConfig'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { PluginScopeProvider, type PluginSourceKind } from './context'
import { PluginWorkbench } from './workbench/PluginWorkbench'
import { WorkbenchTargetProvider } from '../../../workbench/runtime'
import { formatPluginNodeReference, pluginNodeIndexKey } from '@pluxel/core'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../../runtime'

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
	pluginRoute: string
}

type PluginStatusSnapshot = {
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: PluginStatusEntryLifecycleStage
	source: NonNullable<PluginStatusEntry['source']> | null
}

const EMPTY_STATUS_ENTRIES: readonly PluginStatusEntry[] = Object.freeze([])
const EMPTY_DEPENDENCIES: readonly PluginDependency[] = Object.freeze([])

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

function usePluginDetail(pluginRoute?: string) {
	const management = useRuntimeManagementClient()
	const overviewState = usePluginOverview()
	const statusEntries = overviewState.overview?.status?.statuses ?? EMPTY_STATUS_ENTRIES
	const refetchOverview = overviewState.refetch

	const statusMap = useMemo(() => {
		const map = new Map<string, PluginStatusEntry>()
		for (const entry of statusEntries) {
			if (entry?.route) map.set(entry.route, entry)
		}
		return map
	}, [statusEntries])
	const statusByAddress = useMemo(() => {
		const map = new Map<string, PluginStatusEntry>()
		for (const entry of statusEntries) map.set(pluginNodeIndexKey(entry.address), entry)
		return map
	}, [statusEntries])

	const statusEntry = useMemo(() => {
		if (!pluginRoute) return null
		return statusMap.get(pluginRoute) ?? null
	}, [pluginRoute, statusMap])

	const listed = useMemo(() => {
		if (!pluginRoute) return false
		return statusMap.has(pluginRoute)
	}, [pluginRoute, statusMap])

	const owner = statusEntry?.address
	const ownerKey = owner ? pluginNodeIndexKey(owner) : null
	const requestVersionRef = useRef(0)
	const [dependencySnapshot, setDependencySnapshot] = useState<{
		ownerKey: string
		items: readonly PluginDependency[]
	} | null>(null)
	const [dependencyLoading, setDependencyLoading] = useState(false)
	const [dependencyError, setDependencyError] = useState<Error | null>(null)

	const loadDependencies = useCallback(async () => {
		if (!owner || !ownerKey) return
		const requestVersion = ++requestVersionRef.current
		setDependencyLoading(true)
		setDependencyError(null)
		try {
			const result = await management.dependencies.list(owner)
			if (result.ok === false) throw new Error(result.error)
			const items = Object.freeze(
				result.items.map((dependency): PluginDependency => {
					const known = statusByAddress.get(pluginNodeIndexKey(dependency.address))
					return Object.freeze({
						id: known?.id ?? dependency.displayName,
						reference: known?.reference ?? formatPluginNodeReference(dependency.address),
						route: known?.route ?? '',
						displayName: known?.displayName ?? dependency.displayName,
						label: known?.label ?? dependency.displayName,
						rootExportName: known?.rootExportName ?? dependency.address.definition.exportName,
						address: dependency.address,
						isRunning: dependency.isRunning ?? known?.isRunning,
					})
				}),
			)
			if (requestVersion !== requestVersionRef.current) return
			setDependencySnapshot({ ownerKey, items })
		} catch (error: unknown) {
			if (requestVersion !== requestVersionRef.current) return
			setDependencyError(new Error(runtimeErrorMessage(error, '无法读取插件依赖')))
		} finally {
			if (requestVersion === requestVersionRef.current) setDependencyLoading(false)
		}
	}, [management.dependencies, owner, ownerKey, statusByAddress])

	useEffect(() => {
		if (!ownerKey) {
			requestVersionRef.current += 1
			setDependencySnapshot(null)
			setDependencyLoading(false)
			setDependencyError(null)
			return
		}
		void loadDependencies()
	}, [loadDependencies, ownerKey])

	const dependencies =
		dependencySnapshot?.ownerKey === ownerKey ? dependencySnapshot.items : EMPTY_DEPENDENCIES
	const detail = statusEntry
		? {
				route: statusEntry.route,
				address: statusEntry.address,
				rootExportName: statusEntry.rootExportName,
				label: statusEntry.label,
				desc: '',
				dependencies,
			}
		: undefined
	const ready = detail !== undefined
	const loading = overviewState.isLoading || dependencyLoading
	const error =
		!overviewState.hasSnapshot && overviewState.error
			? new Error(overviewState.error)
			: dependencyError

	const refetch = useCallback(async () => {
		await refetchOverview()
	}, [refetchOverview])

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

export const PluginScreen = memo(function PluginScreen({ pluginRoute }: PluginScreenProps) {
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
		usePluginDetail(pluginRoute)
	const pathname = useCurrentPathname()
	const pluginLabel = detail?.label ?? pluginRoute
	const description = detail?.desc ?? ''
	const [statusOverride, setStatusOverride] = useState<{
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: PluginStatusEntryLifecycleStage
	} | null>(null)

	useEffect(() => {
		setStatusOverride(null)
	}, [pluginRoute])

	const resolvedStatus = useMemo(() => resolveStatusSnapshot(statusEntry), [statusEntry])

	useEffect(() => {
		if (resolvedStatus) setStatusOverride(null)
	}, [resolvedStatus])

	const effectiveStatus = statusOverride ?? resolvedStatus
	const isRunning = Boolean(effectiveStatus?.isRunning)
	const isEnabled = effectiveStatus?.isEnabled ?? true
	const lifecycleStage = resolveLifecycleStage(
		isEnabled,
		isRunning,
		effectiveStatus?.lifecycleStage,
	)

	const owner = detail?.address
	const configState = usePluginConfig(ready ? owner : undefined)
	const syncing = useDebouncedFlag(loading || configState.loading, 160)
	const dependencies = detail?.dependencies ?? EMPTY_DEPENDENCIES

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
		if (!detail || !owner) return null
		return {
			owner,
			pluginRoute,
			pluginLabel,
			description,
			dependencies,
			status: statusEntry,
			isRunning,
			isSyncing: syncing,
			isEnabled,
			lifecycleStage,
			source: resolvePluginSource(resolvedStatus),
			refetch: handleRefetch,
			setStatusOverride: handleStatusOverride,
		}
	}, [
		dependencies,
		description,
		pluginLabel,
		owner,
		pluginRoute,
		handleRefetch,
		handleStatusOverride,
		statusEntry,
		isRunning,
		isEnabled,
		lifecycleStage,
		detail,
		resolvedStatus,
		syncing,
	])

	if (!pluginRoute) {
		return (
			<EmptyState
				icon={<IconPuzzle size={28} stroke={1.5} />}
				title="请选择一个插件"
				description="从左侧列表选择插件以查看详情。"
				minHeight="100%"
			/>
		)
	}

	if (pluginRoute && hasStatusSnapshot && !listed && !loading) {
		return (
			<EmptyState
				icon={<IconPuzzle size={28} stroke={1.5} />}
				title="插件不存在"
				description={`未找到插件：${pluginRoute}`}
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

	if (!ready) return <PluginSkeleton stacked={Boolean(isStacked)} />
	if (!contextValue) return null

	return (
		<WorkbenchTargetProvider target={contextValue.owner} pathname={pathname}>
			<PluginScopeProvider value={contextValue}>
				<PluginWorkbench config={configState} />
			</PluginScopeProvider>
		</WorkbenchTargetProvider>
	)
})
