import { Skeleton, useMantineTheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useMemo } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { usePluginConfig } from '../config/usePluginConfig'
import { useWorkbenchDocumentPathname } from '../../workbench/context'
import { PluginScopeProvider } from './context'
import { PluginWorkbench } from './workbench/PluginWorkbench'
import { WorkbenchTargetProvider } from '../../../workbench/runtime'
import { usePluginDetail } from './usePluginDetail'

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
	const pathname = useWorkbenchDocumentPathname()
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
