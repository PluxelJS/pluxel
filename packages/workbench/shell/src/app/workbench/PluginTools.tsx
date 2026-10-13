import { Stack, Text } from '@mantine/core'
import { formatPluginNodeRoute } from '@pluxel/core'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { EmptyState, ErrorState } from '../../components'
import { LiveLog } from '../log_viewer/LiveLog'
import { PluginScopeProvider } from '../plugins/detail/context'
import { usePluginDetail } from '../plugins/detail/usePluginDetail'
import { PluginRuntimeSummaryCard } from '../plugins/detail/cards/PluginRuntimeSummaryCard'
import { PluginDependencyDetailCard } from '../plugins/detail/cards/PluginDependencyDetailCard'
import { LogLevelsCard } from '../plugins/detail/cards/LogLevelsCard'
import { PluginRegionTabs } from './PluginPanels'
import { useWorkspaceSession } from './workspaceContext'

export function PluginTool({ kind }: { kind: 'inspector' | 'logs' }) {
	const session = useWorkspaceSession()
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	const visible = useWorkbenchState(session.workbench, () =>
		session.isToolVisible(`plugin-${kind}`),
	)
	const owner = activeId ? session.documents.get(activeId)?.plugin : undefined
	if (!visible || !session.activeWorkspace()) return null
	if (!owner)
		return (
			<EmptyState title="请选择插件" description="打开插件配置或页面后，此处跟随当前活动插件。" />
		)
	const route = formatPluginNodeRoute(owner)
	return (
		<PluginRegionTabs
			region={kind === 'inspector' ? 'right' : 'bottom'}
			builtins={[
				{
					value: 'builtin',
					label: kind === 'inspector' ? '插件信息' : '插件日志',
					content: <PluginToolContent key={route} pluginRoute={route} kind={kind} />,
				},
			]}
		/>
	)
}

function PluginToolContent({
	pluginRoute,
	kind,
}: {
	pluginRoute: string
	kind: 'inspector' | 'logs'
}) {
	const { detail, statusEntry, dependencyGraph, loading, error, refetch } =
		usePluginDetail(pluginRoute)
	if (!detail || !statusEntry) {
		if (error)
			return (
				<ErrorState title="加载插件失败" message={error.message} onRetry={() => void refetch()} />
			)
		return <EmptyState title={loading ? '正在加载插件…' : '插件不可用'} description={pluginRoute} />
	}
	return (
		<PluginScopeProvider
			value={{
				owner: detail.address,
				pluginRoute,
				pluginLabel: detail.label,
				description: detail.desc,
				status: statusEntry,
				dependencyGraph,
				refetch,
			}}
		>
			<section
				className={`plx-plugin-tool plx-plugin-tool--${kind}`}
				aria-label={kind === 'logs' ? '当前插件日志' : '当前插件信息'}
			>
				<Text
					size="xs"
					fw={600}
					className="plx-plugin-tool__heading"
					truncate="end"
					title={pluginRoute}
				>
					{detail.label}
				</Text>
				{kind === 'logs' ? (
					<LiveLog owner={detail.address} variant="embedded" />
				) : (
					<Stack gap="sm" p="xs" className="plx-plugin-tool__scroll">
						<PluginRuntimeSummaryCard status={statusEntry} description={detail.desc} />
						<PluginDependencyDetailCard />
						<LogLevelsCard owner={detail.address} compact />
					</Stack>
				)}
			</section>
		</PluginScopeProvider>
	)
}
