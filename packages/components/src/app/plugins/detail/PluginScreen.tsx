import {
	Card,
	CardSection,
	Flex,
	Skeleton,
	Stack,
	useMantineTheme,
} from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { ExtensionProvider, useExtensionContext } from '../../../extension'
import { PluginStatusEntryLifecycleStage, type PluginScope, useQuery } from '../../gqty'
import { PluginScopeProvider, type PluginSourceKind } from './context'
import { useDebouncedFlag } from '../../../hooks'
import { usePluginConfig } from '../../hooks'
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
	const query = useQuery({
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

						// For dependency links: we need a list of real plugin names.
						// Base tokens (abstract classes) are not plugins and should not be clickable.
						query.pluginStatus?.statuses.forEach((entry) => {
							entry.name
						})
					}
				: undefined,
	})

	// plugin 不存在时：避免进入“不断 refetch/不断 render skeleton”的循环。
	// 我们用 pluginStatus 的全量名称做一次 membership 判断（它本来就会被 prepare 触发一次），
	// 对不存在的路由直接走稳定 NotFound 视图。
	const exists = useMemo(() => {
		if (!pluginName) return false
		try {
			const statuses = query.pluginStatus?.statuses ?? []
			for (const entry of statuses) {
				if (entry?.name === pluginName) return true
			}
			const hash = pluginName.lastIndexOf('#')
			if (hash > 0) {
				const base = pluginName.slice(0, hash)
				for (const entry of statuses) {
					if (entry?.name === base) return true
				}
			}
		} catch {}
		return false
	}, [pluginName, query.pluginStatus?.statuses])

	let scope: PluginScope | undefined
	let knownPluginNames = new Set<string>()
	if (pluginName !== undefined && exists) {
		try {
			scope = query.plugin({ name: pluginName })
			try {
				const names = new Set<string>()
				for (const entry of query.pluginStatus?.statuses ?? []) {
					const name = entry?.name
					if (typeof name === 'string' && name) names.add(name)
				}
				knownPluginNames = names
			} catch {}
		} catch (error) {
			if (process.env.NODE_ENV !== 'production') {
				console.warn('[PluginScreen] Failed to read plugin scope', error)
			}
			scope = undefined
		}
	}
	const ready = Boolean(scope?.name)

	return {
		scope,
		knownPluginNames,
		ready,
		exists,
		error: query.$state.error,
		loading: query.$state.isLoading,
		refetch: (force?: boolean) => {
			const fn = (query as any)?.$refetch as ((force?: boolean) => Promise<unknown>) | undefined
			if (typeof fn !== 'function') return Promise.resolve()
			return fn(force).then(() => undefined)
		},
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
				: theme.breakpoints?.lg ?? '62em'
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
		dependencies: any[]
		status: { isRunning: boolean; isEnabled: boolean; lifecycleStage: any } | null
		source: any | null
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
