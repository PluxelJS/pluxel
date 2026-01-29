import { Card, CardSection, Flex, Skeleton, Stack, useMantineTheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, ErrorState } from '../../../../components'
import { ExtensionProvider, useExtensionContext } from '../../../../extension'
import { useDebouncedFlag } from '../../../../hooks'
import { type PluginScope, type PluginStatusEntry, PluginStatusEntryLifecycleStage, useQuery } from '../../../gqty'
import { usePluginConfig } from '../../../hooks'
import { usePluginOverview } from '../../data'
import { PluginScopeProvider, type PluginSourceKind } from '../context'
import { PluginLayout } from '../panels/PluginLayout'

const LEFT_SKELETON_WIDTH = 'clamp(320px, 34vw, 480px)'

function PluginSkeleton({ stacked }: { stacked: boolean }) {
	return (
		<Flex
			direction={stacked ? 'column' : 'row'}
			gap="md"
			h={stacked ? 'auto' : '100%'}
			style={{ minHeight: 0, minWidth: 0 }}
		>
			<Card
				withBorder
				shadow="sm"
				style={{
					flex: stacked ? 'initial' : '0 0 auto',
					width: stacked ? '100%' : LEFT_SKELETON_WIDTH,
					minWidth: 0,
					minHeight: stacked ? 'auto' : '100%',
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				<CardSection withBorder px="md" py="sm">
					<Stack gap={8}>
						<Skeleton height={24} width="60%" radius="sm" />
						<Flex gap={8}>
							<Skeleton height={20} width={88} radius="xl" />
							<Skeleton height={20} width={88} radius="xl" />
						</Flex>
					</Stack>
				</CardSection>
				<CardSection px="md" py="sm" style={{ flex: 1 }}>
					<Stack gap="sm" h="100%">
						<Skeleton height={14} width="90%" />
						<Skeleton height={14} width="75%" />
						<Skeleton height={14} width="82%" />
						<Skeleton height="100%" radius="md" />
					</Stack>
				</CardSection>
			</Card>

			<Card
				withBorder
				shadow="sm"
				style={{
					flex: 1,
					minWidth: 0,
					minHeight: stacked ? 260 : '100%',
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				<CardSection withBorder px="md" py="sm">
					<Skeleton height={22} width="30%" radius="sm" />
				</CardSection>
				<CardSection px="md" py="sm" style={{ flex: 1 }}>
					<Stack gap="sm" h="100%">
						<Skeleton height={14} width="92%" />
						<Skeleton height={14} width="86%" />
						<Skeleton height="100%" radius="md" />
					</Stack>
				</CardSection>
			</Card>
		</Flex>
	)
}

export interface PluginScreenProps {
	pluginName: string
}

function usePluginDetail(pluginName?: string) {
	// Reuse the global overview snapshot to avoid duplicate status requests on plugin pages.
	const overview = usePluginOverview()
	const statusEntries = overview.overview?.status?.statuses ?? []

	const statusMap = useMemo(() => {
		const map = new Map<string, PluginStatusEntry>()
		for (const entry of statusEntries) {
			if (entry?.name) map.set(entry.name, entry)
		}
		return map
	}, [statusEntries])

	const knownPluginNames = useMemo(() => {
		const names = new Set<string>()
		for (const entry of statusEntries) {
			if (entry?.name) names.add(entry.name)
		}
		return names
	}, [statusEntries])

	const statusEntry = useMemo(() => {
		if (!pluginName) return null
		let entry = statusMap.get(pluginName) ?? null
		if (!entry) {
			const hash = pluginName.lastIndexOf('#')
			if (hash > 0) entry = statusMap.get(pluginName.slice(0, hash)) ?? null
		}
		return entry
	}, [pluginName, statusMap])

	const listed = useMemo(() => {
		if (!pluginName) return false
		if (knownPluginNames.has(pluginName)) return true
		const hash = pluginName.lastIndexOf('#')
		if (hash > 0) return knownPluginNames.has(pluginName.slice(0, hash))
		return false
	}, [pluginName, knownPluginNames])

	// Always request detail; we handle missing plugins via stable UI decisions instead of gating.
	const detailQuery = useQuery({
		suspense: false,
		operationName: 'PluginDetailView',
		notifyOnNetworkStatusChange: true,
		refetchOnWindowVisible: false,
		refetchOnReconnect: false,
		prepare:
			pluginName !== undefined
				? ({ query }) => {
						const scope = query.plugin({ name: pluginName })
						scope.name
						const detail = scope.detail
						detail.desc
						detail.dependencies.forEach((dep) => {
							dep.name
							dep.isRunning
						})
						// status comes from overview snapshot
					}
				: undefined,
	})

	let scope: PluginScope | undefined
	if (pluginName !== undefined) {
		try {
			scope = detailQuery.plugin({ name: pluginName })
		} catch (error) {
			if (process.env.NODE_ENV !== 'production') {
				console.warn('[PluginScreen] Failed to read plugin scope', error)
			}
			scope = undefined
		}
	}
	const ready = Boolean(scope?.name)

	const loading =
		Boolean(detailQuery.$state.isLoading || detailQuery.$state.isFetching)
	const error = detailQuery.$state.error

	const refetch = (force?: boolean) => {
		type Refetchable = { $refetch?: (force?: boolean) => Promise<unknown> }
		const tasks: Promise<unknown>[] = []
		const detailRefetch = (detailQuery as unknown as Refetchable).$refetch
		if (typeof detailRefetch === 'function') tasks.push(detailRefetch(force))
		if (tasks.length === 0) return Promise.resolve()
		return Promise.allSettled(tasks).then(() => undefined)
	}

	return {
		scope,
		knownPluginNames,
		ready,
		listed,
		hasStatusSnapshot: overview.hasSnapshot,
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

	const { scope, knownPluginNames, ready, listed, hasStatusSnapshot, statusEntry, error, loading, refetch } =
		usePluginDetail(pluginName)
	const parentExtensionCtx = useExtensionContext()

	// 稳定快照：refetch/同步期间，GQty 可能短暂返回空字段，导致 UI “0 依赖/空注入卡片”闪一下。
	// 这里缓存上一份成功读取到的 detail，用于过渡期展示。
	const lastStableRef = useRef<{
		scope: PluginScope
		name: string
		desc: string
		dependencies: Array<{ name?: string | null; isRunning?: boolean | null }>
	} | null>(null)

	useEffect(() => {
		if (!scope?.name) {
			lastStableRef.current = null
			return
		}
		try {
			const deps = Array.isArray(scope.detail?.dependencies) ? [...scope.detail.dependencies] : []
			lastStableRef.current = {
				scope,
				name: scope.name,
				desc: scope.detail?.desc ?? '',
				dependencies: deps,
			}
		} catch {
			// ignore
		}
	}, [scope?.name, scope?.detail?.desc, scope?.detail?.dependencies])

	const stable = lastStableRef.current
	const viewReady = ready || Boolean(stable?.name)
	const displayName = scope?.name ?? stable?.name ?? pluginName
	const description = scope?.detail?.desc ?? stable?.desc ?? ''
	const statusRef = useRef<{
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: PluginStatusEntryLifecycleStage
		source: NonNullable<PluginStatusEntry['source']> | null
	} | null>(null)
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

	const resolvedStatus = useMemo(() => {
		if (!statusEntry) return null
		const isEnabled = statusEntry.isEnabled !== false
		const isRunning = Boolean(statusEntry.isRunning)
		const lifecycleStage =
			statusEntry.lifecycleStage ??
			(isEnabled
				? isRunning
					? PluginStatusEntryLifecycleStage.running
					: PluginStatusEntryLifecycleStage.stopped
				: PluginStatusEntryLifecycleStage.disabled)
		return {
			isRunning,
			isEnabled,
			lifecycleStage,
			source: statusEntry.source ?? null,
		}
	}, [statusEntry])

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
	const lifecycleStage =
		effectiveStatus?.lifecycleStage ??
		(isEnabled
			? isRunning
				? PluginStatusEntryLifecycleStage.running
				: PluginStatusEntryLifecycleStage.stopped
			: PluginStatusEntryLifecycleStage.disabled)

	const configState = usePluginConfig(viewReady ? displayName : undefined)
	const syncing = useDebouncedFlag(loading || configState.loading, 160)

	const rawDeps = scope?.detail?.dependencies
	const stableDeps = stable?.dependencies ?? []
	const preferStableDeps = Boolean(
		rawDeps && Array.isArray(rawDeps) && rawDeps.length === 0 && stableDeps.length > 0,
	)
	const dependencies = syncing && preferStableDeps ? stableDeps : (rawDeps ?? stableDeps)

	const handleRefetch = useCallback(async () => {
		await refetch(true)
	}, [refetch])

	const handleStatusOverride = useCallback(
		(next: { isRunning: boolean; isEnabled: boolean; lifecycleStage: PluginStatusEntryLifecycleStage }) => {
			setStatusOverride(next)
		},
		[],
	)

	const contextValue = useMemo(() => {
		const effectiveScope = scope ?? stable?.scope
		if (!effectiveScope) return null
		const rawSource = effectiveStatusEntry?.source ?? effectiveStatus?.source
		const source = {
			kind: (rawSource?.kind ?? 'unknown') as PluginSourceKind,
			moduleId: rawSource?.moduleId ?? null,
			packageName: rawSource?.packageName ?? null,
			version: rawSource?.version ?? null,
			tag: rawSource?.tag ?? null,
		}
		return {
			pluginName: displayName,
			description,
			scope: effectiveScope,
			dependencies,
			knownPluginNames,
			status: effectiveStatusEntry,
			isRunning,
			isSyncing: syncing,
			isEnabled,
			lifecycleStage,
			source,
			refetch: handleRefetch,
			setStatusOverride: handleStatusOverride,
		}
	}, [
		dependencies,
		description,
		displayName,
		effectiveStatus,
		handleRefetch,
		handleStatusOverride,
		knownPluginNames,
		effectiveStatusEntry,
		isRunning,
		isEnabled,
		lifecycleStage,
		scope,
		statusEntry,
		stable,
		syncing,
	])

	const pluginExtensionCtx = useMemo(() => {
		if (!parentExtensionCtx) return null
		return {
			...parentExtensionCtx,
			pluginName: displayName,
		}
	}, [parentExtensionCtx, displayName])

	if (!pluginName) {
		return (
			<EmptyState
				icon={<IconPuzzle size={28} stroke={1.5} />}
				title="请选择一个插件"
				description="从左侧列表选择插件以查看详情。"
				withPattern
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
				withPattern
				minHeight="100%"
			/>
		)
	}

	if (error && !ready) {
		return (
			<ErrorState
				title="加载失败"
				message={error.message || '无法加载插件详情，请重试'}
				onRetry={() => void refetch(true)}
				withPattern
				minHeight="100%"
			/>
		)
	}

	if (!viewReady) return <PluginSkeleton stacked={Boolean(isStacked)} />
	if (!contextValue || !pluginExtensionCtx) return null

	return (
		<ExtensionProvider value={pluginExtensionCtx}>
			<PluginScopeProvider value={contextValue}>
				<PluginLayout config={configState} stacked={Boolean(isStacked)} />
			</PluginScopeProvider>
		</ExtensionProvider>
	)
})
