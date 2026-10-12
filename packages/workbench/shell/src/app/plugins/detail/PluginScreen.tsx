import { Skeleton, Stack } from '@mantine/core'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useMemo } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { usePluginConfig } from '../config/usePluginConfig'
import { PluginScopeProvider } from './context'
import { RightPane } from './RightPane'
import { usePluginDetail } from './usePluginDetail'

function PluginSkeleton() {
	return (
		<Stack p="md">
			<Skeleton h={24} w="40%" />
			<Skeleton h={120} />
			<Skeleton h={240} />
		</Stack>
	)
}

export interface PluginScreenProps {
	pluginRoute: string
}

export const PluginScreen = memo(function PluginScreen({ pluginRoute }: PluginScreenProps) {
	const {
		detail,
		ready,
		listed,
		hasStatusSnapshot,
		statusEntry,
		dependencyGraph,
		error,
		loading,
		refetch,
	} = usePluginDetail(pluginRoute)
	const pluginLabel = detail?.label ?? pluginRoute
	const description = detail?.desc ?? ''

	const owner = detail?.address
	const configState = usePluginConfig(ready ? owner : undefined)

	const handleRefetch = useCallback(async () => {
		await refetch()
	}, [refetch])

	const contextValue = useMemo(() => {
		if (!detail || !owner || !statusEntry) return null
		return {
			owner,
			pluginRoute,
			pluginLabel,
			description,
			dependencyGraph,
			status: statusEntry,
			refetch: handleRefetch,
		}
	}, [
		dependencyGraph,
		description,
		pluginLabel,
		owner,
		pluginRoute,
		handleRefetch,
		statusEntry,
		detail,
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

	if (!ready) return <PluginSkeleton />
	if (!contextValue) return null

	return (
		<PluginScopeProvider value={contextValue}>
			<div className="plx-pluginDocument">
				<RightPane config={configState} />
			</div>
		</PluginScopeProvider>
	)
})
