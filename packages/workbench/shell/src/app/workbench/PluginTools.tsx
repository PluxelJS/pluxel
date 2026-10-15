import { Button, Group, Stack, Text, Tabs } from '@mantine/core'
import { formatPluginNodeRoute, type PluginNodeAddress } from '@pluxel/core'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { EmptyState, ErrorState } from '../../components'
import { LogPreview } from '../log_viewer/LogPreview'
import { PluginScopeProvider } from '../plugins/detail/context'
import { usePluginDetail } from '../plugins/detail/usePluginDetail'
import { PluginRuntimeSummaryCard } from '../plugins/detail/cards/PluginRuntimeSummaryCard'
import { PluginDependencyDetailCard } from '../plugins/detail/cards/PluginDependencyDetailCard'
import { LogPolicyPopover } from '../log_viewer/LogPolicyPopover'
import { Actions, Model, TabNode } from 'flexlayout-react'
import { PluginPanelDirectory } from './PluginPanelDirectory'
import { useWorkspaceSession } from './workspaceContext'
import { useWorkbenchNavigation } from './context'
import { buildPluginLogsHref } from '../../workbench/paths'

export function PluginTool() {
	const session = useWorkspaceSession()
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	const visible = useWorkbenchState(session.workbench, () =>
		session.isToolVisible('plugin-inspector'),
	)
	const selected = useWorkbenchState(session.workbench, () => {
		const node = Model.fromJson(session.workbench.getLayout()).getNodeById('plugin-inspector')
		return node instanceof TabNode && node.getConfig()?.panelView === 'logs' ? 'logs' : 'builtin'
	})
	const owner = activeId ? session.documents.get(activeId)?.plugin : undefined
	if (!visible || !session.activeWorkspace()) return null
	if (!owner)
		return (
			<EmptyState title="请选择插件" description="打开插件配置或页面后，此处跟随当前活动插件。" />
		)
	const route = formatPluginNodeRoute(owner)
	return (
		<Tabs
			value={selected}
			keepMounted={false}
			className="plx-plugin-region"
			onChange={(value) => {
				if (!value) return
				const node = Model.fromJson(session.workbench.getLayout()).getNodeById(
					'plugin-inspector',
				) as TabNode
				void session.workbench
					.dispatch(
						Actions.updateNodeAttributes('plugin-inspector', {
							config: { ...node.getConfig(), panelView: value },
						}),
					)
					.then((result) => session.check(result))
					.catch((error: unknown) => session.report(error))
			}}
		>
			<Tabs.List className="plx-plugin-region__tabs" aria-label="官方插件面板">
				<Tabs.Tab value="builtin">插件信息</Tabs.Tab>
				<Tabs.Tab value="logs">最近日志</Tabs.Tab>
			</Tabs.List>
			<Tabs.Panel value="builtin" className="plx-plugin-region__content">
				{selected === 'builtin' && <PluginToolContent key={route} pluginRoute={route} />}
			</Tabs.Panel>
			<Tabs.Panel value="logs" className="plx-plugin-region__content">
				{selected === 'logs' && <PluginLogTool key={route} owner={owner} pluginRoute={route} />}
			</Tabs.Panel>
		</Tabs>
	)
}

function PluginToolContent({ pluginRoute }: { pluginRoute: string }) {
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
			<section className="plx-plugin-tool plx-plugin-tool--inspector" aria-label="当前插件信息">
				<Group gap="xs" wrap="wrap" className="plx-plugin-tool__heading">
					<Text size="xs" fw={600} truncate="end" title={pluginRoute} style={{ minWidth: 0 }}>
						{detail.label}
					</Text>
				</Group>
				<Stack gap="sm" p="xs" className="plx-plugin-tool__scroll">
					<PluginRuntimeSummaryCard status={statusEntry} description={detail.desc} />
					<PluginDependencyDetailCard />
					<PluginPanelDirectory />
				</Stack>
			</section>
		</PluginScopeProvider>
	)
}

function PluginLogTool({ owner, pluginRoute }: { owner: PluginNodeAddress; pluginRoute: string }) {
	const navigation = useWorkbenchNavigation()
	const { detail } = usePluginDetail(pluginRoute)
	const label = detail?.label ?? pluginRoute
	return (
		<section className="plx-plugin-tool" aria-label="插件最近日志面板">
			<Stack gap="xs" p="xs" style={{ flexShrink: 0, borderBottom: '1px solid var(--plx-border)' }}>
				<Group gap="xs" justify="space-between">
					<Text size="xs" fw={600} truncate title={label} style={{ minWidth: 0, flex: 1 }}>
						{label}
					</Text>
					<LogPolicyPopover owner={owner} />
				</Group>
				<Group justify="space-between" gap="xs">
					<Text size="xs" c="dimmed">
						最近 10 条
					</Text>
					<Button
						variant="subtle"
						size="compact-xs"
						onClick={() =>
							navigation.openTab({ path: buildPluginLogsHref(owner), title: `日志 · ${label}` })
						}
					>
						查看完整插件日志
					</Button>
				</Group>
			</Stack>
			<div className="plx-plugin-tool__scroll" style={{ padding: 'var(--mantine-spacing-xs)' }}>
				<LogPreview owner={owner} />
			</div>
		</section>
	)
}
