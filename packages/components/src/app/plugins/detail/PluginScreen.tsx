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
import { memo, useCallback, useMemo } from 'react'
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

	let scope: PluginScope | undefined
	let knownPluginNames = new Set<string>()
	if (pluginName !== undefined) {
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

	const { scope, knownPluginNames, ready, error, loading, refetch } = usePluginDetail(pluginName)
	const parentExtensionCtx = useExtensionContext()

	const displayName = scope?.name ?? pluginName
	const dependencies = scope?.detail?.dependencies ?? []
	const description = scope?.detail?.desc ?? ''
	const isRunning = Boolean(scope?.status?.isRunning)
	const isEnabled = Boolean(scope?.status?.isEnabled)
	const lifecycleStage =
		scope?.status?.lifecycleStage ??
		(isEnabled
			? isRunning
				? PluginStatusEntryLifecycleStage.running
				: PluginStatusEntryLifecycleStage.stopped
			: PluginStatusEntryLifecycleStage.disabled)

	const configState = usePluginConfig(ready ? displayName : undefined)
	const syncing = useDebouncedFlag(loading || configState.loading, 160)

	const handleRefetch = useCallback(async () => {
		await refetch(true)
	}, [refetch])

	const contextValue = useMemo(() => {
		if (!scope) return null
		const rawSource = scope.status?.source
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
			scope,
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

	if (!ready) return <PluginSkeleton stacked={Boolean(isStacked)} />
	if (!scope || !contextValue || !pluginExtensionCtx) return null

	return (
		<ExtensionProvider value={pluginExtensionCtx}>
			<PluginScopeProvider value={contextValue}>
				<PluginLayout config={configState} stacked={Boolean(isStacked)} />
			</PluginScopeProvider>
		</ExtensionProvider>
	)
})
