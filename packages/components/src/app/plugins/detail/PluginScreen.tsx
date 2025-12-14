import { Card, CardSection, Flex, Skeleton, Stack, useMantineTheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { ExtensionProvider, useExtensionContext } from '../../../extension'
import { useDebouncedFlag } from '../../../hooks'
import { type PluginScope, PluginStatusEntryLifecycleStage, useQuery } from '../../gqty'
import { usePluginConfig } from '../../hooks'
import { PluginScopeProvider, type PluginSourceKind } from './context'
import { PluginLayout } from './PluginLayout'

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
	// 先只取 pluginStatus（稳定、便宜），用于：
	// 1) 判断插件是否存在（不存在就不要再请求 detail，避免 404/错误导致“疯狂重试刷屏”）
	// 2) 给依赖列表提供“可跳转的真实插件名”集合（base token 不可跳转）
	const statusQuery = useQuery({
		suspense: false,
		operationName: 'PluginStatusForDetail',
		notifyOnNetworkStatusChange: true,
		refetchOnWindowVisible: false,
		refetchOnReconnect: false,
		prepare: ({ query }) => {
			query.pluginStatus?.statuses.forEach((entry) => {
				entry.name
				entry.isRunning
			})
		},
	})

	const knownPluginNames = useMemo(() => {
		const names = new Set<string>()
		for (const entry of statusQuery.pluginStatus?.statuses ?? []) {
			const name = entry?.name
			if (typeof name === 'string' && name) names.add(name)
		}
		return names
	}, [statusQuery.pluginStatus?.statuses])

	const exists = useMemo(() => {
		if (!pluginName) return false
		if (knownPluginNames.has(pluginName)) return true
		const hash = pluginName.lastIndexOf('#')
		if (hash > 0) return knownPluginNames.has(pluginName.slice(0, hash))
		return false
	}, [pluginName, knownPluginNames])

	// 仅在 exists 时才请求 detail，避免“不存在插件”导致 detail query 报错然后持续重试
	const detailQuery = useQuery({
		suspense: false,
		operationName: 'PluginDetailView',
		notifyOnNetworkStatusChange: true,
		refetchOnWindowVisible: false,
		refetchOnReconnect: false,
		prepare:
			pluginName !== undefined && exists
				? ({ query }) => {
						const scope = query.plugin({ name: pluginName })
						scope.name
						const detail = scope.detail
						detail.desc
						detail.dependencies.forEach((dep) => {
							dep.name
							dep.isRunning
						})
						const status = scope.status
						status.isRunning
						status.isEnabled
						status.lifecycleStage
						const source = status.source
						source.__typename
						source.kind
						source.moduleId
						source.packageName
						source.version
						source.tag
					}
				: undefined,
	})

	let scope: PluginScope | undefined
	if (pluginName !== undefined && exists) {
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
		Boolean(statusQuery.$state.isLoading || statusQuery.$state.isFetching) ||
		(exists && Boolean(detailQuery.$state.isLoading || detailQuery.$state.isFetching))
	const error = statusQuery.$state.error ?? detailQuery.$state.error

	const refetch = (force?: boolean) => {
		type Refetchable = { $refetch?: (force?: boolean) => Promise<unknown> }
		const tasks: Promise<unknown>[] = []
		const statusRefetch = (statusQuery as unknown as Refetchable).$refetch
		if (typeof statusRefetch === 'function') tasks.push(statusRefetch(force))
		const detailRefetch = (detailQuery as unknown as Refetchable).$refetch
		if (typeof detailRefetch === 'function' && exists) tasks.push(detailRefetch(force))
		if (tasks.length === 0) return Promise.resolve()
		return Promise.allSettled(tasks).then(() => undefined)
	}

	return {
		scope,
		knownPluginNames,
		ready,
		exists,
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

	const { scope, knownPluginNames, ready, exists, error, loading, refetch } =
		usePluginDetail(pluginName)
	const parentExtensionCtx = useExtensionContext()

	// 稳定快照：refetch/同步期间，GQty 可能短暂返回空字段，导致 UI “0 依赖/空注入卡片”闪一下。
	// 这里缓存上一份成功读取到的 detail/status，用于过渡期展示。
	const lastStableRef = useRef<{
		scope: PluginScope
		name: string
		desc: string
		dependencies: Array<{ name?: string | null; isRunning?: boolean | null }>
		status: {
			isRunning: boolean
			isEnabled: boolean
			lifecycleStage: PluginStatusEntryLifecycleStage
		} | null
		source: {
			kind?: unknown
			moduleId?: string | null
			packageName?: string | null
			version?: string | null
			tag?: string | null
		} | null
	} | null>(null)

	useEffect(() => {
		if (!exists || !scope?.name) {
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
				status: scope.status
					? {
							isRunning: Boolean(scope.status.isRunning),
							isEnabled: Boolean(scope.status.isEnabled),
							lifecycleStage: scope.status.lifecycleStage,
						}
					: null,
				source: scope.status?.source ?? null,
			}
		} catch {
			// ignore
		}
	}, [exists, scope?.name, scope?.detail?.desc, scope?.detail?.dependencies, scope?.status])

	const stable = lastStableRef.current
	const viewReady = ready || Boolean(stable?.name)
	const displayName = scope?.name ?? stable?.name ?? pluginName
	const description = scope?.detail?.desc ?? stable?.desc ?? ''
	const isRunning = Boolean(scope?.status?.isRunning ?? stable?.status?.isRunning)
	const isEnabled = Boolean(scope?.status?.isEnabled ?? stable?.status?.isEnabled)
	const lifecycleStage =
		scope?.status?.lifecycleStage ??
		stable?.status?.lifecycleStage ??
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

	const contextValue = useMemo(() => {
		const effectiveScope = scope ?? stable?.scope
		if (!effectiveScope) return null
		const rawSource = scope?.status?.source ?? stable?.source
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
			isRunning,
			isSyncing: syncing,
			isEnabled,
			lifecycleStage,
			source,
			refetch: handleRefetch,
		}
	}, [
		dependencies,
		description,
		displayName,
		handleRefetch,
		knownPluginNames,
		isRunning,
		isEnabled,
		lifecycleStage,
		scope,
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

	// 不存在：稳定 NotFound，避免循环请求刷屏。
	if (pluginName && !exists && !loading) {
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
