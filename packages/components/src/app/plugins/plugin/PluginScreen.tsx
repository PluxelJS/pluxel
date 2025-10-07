import { Box, Button, Card, Center, Text } from '@mantine/core'
import { memo, useCallback, useMemo } from 'react'
import type { PluginScope } from '../../gqty'
import { useQuery } from '../../gqty'
import { PluginScopeProvider } from './context'
import { useDebouncedFlag } from './hooks/useDebouncedFlag'
import { usePluginConfig } from './hooks/usePluginConfig'
import { PluginLayout } from './PluginLayout'
import { toDependencySnapshots } from './utils'

const LEFT_SKELETON_WIDTH = 'clamp(320px, 34vw, 480px)'

function PluginSkeleton() {
	return (
		<Box
			style={{
				display: 'flex',
				gap: 'var(--mantine-spacing-md)',
				height: '100%',
				minHeight: 0,
				minWidth: 0,
			}}
		>
			<Card
				withBorder
				shadow="sm"
				style={{ width: LEFT_SKELETON_WIDTH, minWidth: 0, height: '100%' }}
			/>
			<Card withBorder shadow="sm" style={{ flex: 1, minWidth: 0, height: '100%' }} />
		</Box>
	)
}

export interface PluginScreenProps {
	pluginName: string
}

export const PluginScreen = memo(function PluginScreen({ pluginName }: PluginScreenProps) {
	const query = useQuery({
		suspense: false,
		operationName: 'PluginDetailView',
		notifyOnNetworkStatusChange: true,
		refetchOnWindowVisible: false,
		refetchOnReconnect: false,
		prepare: pluginName
			? ({ query }) => {
					const scope = query.plugin({ name: pluginName })
					scope.name
					const detail = scope.detail
					detail.desc
					detail.dependencies.map((dep) => {
						dep.name
						dep.optional
						dep.isRunning
					})
					scope.status.isRunning
				}
			: undefined,
	})

	const scope: PluginScope | undefined = pluginName ? query.plugin({ name: pluginName }) : undefined
	const ready = Boolean(scope?.name)
	const displayName = scope?.name ?? pluginName
	const dependencies = useMemo(
		() => toDependencySnapshots(scope?.detail?.dependencies),
		[scope?.detail?.dependencies],
	)
	const description = scope?.detail?.desc ?? ''
	const isRunning = Boolean(scope?.status?.isRunning)
	const configState = usePluginConfig(ready ? displayName : undefined)
	const syncing = useDebouncedFlag(query.$state.isLoading || configState.loading, 160)

	const refetch = useCallback(async () => {
		await query.$refetch(true)
	}, [query])
	const contextValue = useMemo(
		() => ({
			pluginName: displayName,
			description,
			scope,
			dependencies,
			isRunning,
			isSyncing: syncing,
			refetch,
		}),
		[dependencies, description, displayName, isRunning, refetch, scope, syncing],
	)

	if (!pluginName) {
		return (
			<Center h="100%">
				<Text c="dimmed" size="lg">
					请选择一个插件以查看详情
				</Text>
			</Center>
		)
	}

	if (query.$state.error && !ready) {
		return (
			<Center h="100%" style={{ gap: 12, flexDirection: 'column' }}>
				<Text c="red">{query.$state.error.message || '加载失败，请重试'}</Text>
				<Button size="xs" onClick={() => void query.$refetch(true)}>
					重试
				</Button>
			</Center>
		)
	}

	if (!ready) return <PluginSkeleton />

	if (!scope) return null

	return (
		<PluginScopeProvider value={contextValue}>
			<PluginLayout config={configState} />
		</PluginScopeProvider>
	)
})
