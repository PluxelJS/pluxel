import { Badge, Box, Center, Loader, Stack, Tabs, Text } from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'

import { EmptyState, ErrorState } from '../../../components'
import { useResolvedWorkbenchRoute, useWorkbenchTabs } from '../../../workbench/runtime'
import { useWorkbenchDocumentPathname } from '../../workbench/context'
import { WorkbenchRouteRenderer } from '../../router/workbench/WorkbenchRouteRenderer'
import { PANE_TABS_PROPS, PaneTabLabel, getPaneTabsRootClassName } from '../../workbench/PaneTabs'
import type { PluginConfigState } from '../config/usePluginConfig'
import { ConfigForm } from '../config/ConfigForm'
import { LogLevelsCard } from './cards/LogLevelsCard'
import { PluginPanel } from './cards/PluginPanel'
import { ActionBar } from './controls/ActionBar'
import { usePluginMeta } from './context'
import { buildRightPaneTabGroups, normalizeRestPath } from './rightPaneState'
import { PluginWorkbenchTabActivityProvider } from './workbench/tabActivity'

interface RightPaneProps {
	config: PluginConfigState
	showLevelsTab?: boolean
}

const COLUMN_STYLE = {
	flex: 1,
	minHeight: 0,
	display: 'flex',
	flexDirection: 'column' as const,
}

function PaneTabPanel({ children, value }: { children: ReactNode; value: string }) {
	return (
		<Tabs.Panel value={value} className="plx-paneTabs__panel" style={COLUMN_STYLE}>
			{children}
		</Tabs.Panel>
	)
}

export function RightPane({ config, showLevelsTab = false }: RightPaneProps) {
	const { owner, pluginRoute, pluginLabel, source } = usePluginMeta()
	const { nodes: tabNodes, entries: tabEntries } = useWorkbenchTabs()
	const tabGroups = useMemo(
		() => buildRightPaneTabGroups(pluginLabel, tabEntries, tabNodes as ReactNode[]),
		[pluginLabel, tabEntries, tabNodes],
	)
	const pathname = useWorkbenchDocumentPathname()
	const restPath = useMemo(() => {
		const prefix = `/plugins/${pluginRoute}`
		if (!pathname.startsWith(prefix)) return ''
		return normalizeRestPath(pathname.slice(prefix.length))
	}, [pathname, pluginRoute])
	const showRouteTab = Boolean(restPath && restPath !== '/config')
	const [activeTab, setActiveTab] = useState(showRouteTab ? 'route' : 'config')
	useEffect(() => {
		if (showRouteTab) setActiveTab('route')
	}, [restPath, showRouteTab])
	const sourceLabel =
		source.kind === 'hmr' ? 'HMR' : source.kind === 'package' ? '包安装' : '未知来源'

	return (
		<PluginPanel className="plx-pluginWorkbench__contentPanel" padding={4} gap={4}>
			<Box style={COLUMN_STYLE}>
				<Tabs
					{...PANE_TABS_PROPS}
					value={activeTab}
					onChange={(value) => setActiveTab(value ?? 'config')}
					keepMounted
					style={COLUMN_STYLE}
					className={getPaneTabsRootClassName('toolbar')}
				>
					<div className="plx-pluginWorkbench__toolbar">
						<div className="plx-pluginWorkbench__commandBar">
							<div className="plx-pluginWorkbench__commandTitle">
								<span className="plx-pluginWorkbench__commandName">{pluginLabel}</span>
								<Badge size="sm" variant="light">
									{sourceLabel}
								</Badge>
							</div>
							<ActionBar />
						</div>
						<Tabs.List className="plx-paneTabs__list" aria-label="插件工作台标签页">
							{showRouteTab ? (
								<Tabs.Tab value="route">
									<PaneTabLabel label="页面" />
								</Tabs.Tab>
							) : null}
							<Tabs.Tab value="config">
								<PaneTabLabel label="配置" />
							</Tabs.Tab>
							{showLevelsTab ? (
								<Tabs.Tab value="logging">
									<PaneTabLabel label="级别" />
								</Tabs.Tab>
							) : null}
							{tabGroups.map((tab) => (
								<Tabs.Tab key={tab.id} value={tab.id}>
									<PaneTabLabel label={tab.label} />
								</Tabs.Tab>
							))}
						</Tabs.List>
					</div>

					{showRouteTab ? (
						<PaneTabPanel value="route">
							<RouteContent
								target={owner}
								displayName={pluginLabel}
								displayPath={pathname}
								restPath={restPath}
							/>
						</PaneTabPanel>
					) : null}
					<PaneTabPanel value="config">
						<ConfigContent
							config={config}
							owner={owner}
							displayName={pluginLabel}
							active={activeTab === 'config'}
						/>
					</PaneTabPanel>
					{showLevelsTab ? (
						<PaneTabPanel value="logging">
							<LogLevelsCard owner={owner} compact />
						</PaneTabPanel>
					) : null}
					{tabGroups.map((tab) => (
						<PaneTabPanel key={tab.id} value={tab.id}>
							<PluginWorkbenchTabActivityProvider active={activeTab === tab.id}>
								<Stack gap="sm">
									{tab.nodes.map(({ key, node }) => (
										<Fragment key={key}>{node}</Fragment>
									))}
								</Stack>
							</PluginWorkbenchTabActivityProvider>
						</PaneTabPanel>
					))}
				</Tabs>
			</Box>
		</PluginPanel>
	)
}

function ConfigContent({
	config,
	owner,
	displayName,
	active,
}: {
	config: PluginConfigState
	owner: import('@pluxel/core').PluginNodeAddress
	displayName: string
	active: boolean
}) {
	if (config.error)
		return (
			<ErrorState
				title="加载配置失败"
				message={config.error.message}
				onRetry={() => void config.refetch()}
				minHeight={200}
			/>
		)
	if (config.loading && !config.data)
		return (
			<Center style={{ flex: 1, gap: 8 }}>
				<Loader size="sm" />
				<Text c="dimmed">加载配置中…</Text>
			</Center>
		)
	if (!config.data || config.data.fields.length === 0)
		return (
			<EmptyState
				icon={<IconSettingsOff size={28} />}
				title="暂无可配置项"
				description="该插件未提供配置展示计划。"
				minHeight={200}
			/>
		)
	return (
		<ConfigForm
			owner={owner}
			displayName={displayName}
			fields={config.data.fields}
			savedConfig={config.data.savedConfig}
			defaults={config.data.defaults}
			sections={config.data.sections}
			active={active}
		/>
	)
}

function RouteContent({
	target,
	displayName,
	displayPath,
	restPath,
}: {
	target: import('@pluxel/core').PluginNodeAddress
	displayName: string
	displayPath: string
	restPath: string
}) {
	const { route, snapshot } = useResolvedWorkbenchRoute(target, restPath)
	return (
		<WorkbenchRouteRenderer
			target={target}
			displayName={displayName}
			displayPath={displayPath}
			pathname={displayPath}
			route={route}
			snapshot={snapshot}
		/>
	)
}
