import { ActionIcon, Collapse, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core'
import { IconChevronDown } from '@tabler/icons-react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LiveLog as LiveLogRaw } from '../../../log_viewer/LiveLog'
import { usePluginMeta } from '../context'
import { ProviderPolicyCard } from '../cards/ProviderPolicyCard'
import { PluginDependencyDetailCard } from '../cards/PluginDependencyDetailCard'
import { LogLevelsCard } from '../cards/LogLevelsCard'
import { PluginRuntimeSummaryCard } from '../cards/PluginRuntimeSummaryCard'
import {
	type PluginWorkbenchView,
	PluginWorkbenchViewContainer,
} from './PluginWorkbenchViewContainer'
import { usePluginWorkbenchAside } from './context'

const LiveLog = memo(LiveLogRaw)

const SIDEBAR_VIEW_SCOPE = 'plugin:workbench:sidebar-view'
const PANEL_VIEW_SCOPE = 'plugin:workbench:panel-view'

function WorkbenchScrollPane({
	children,
	compact = false,
}: {
	children: ReactNode
	compact?: boolean
}) {
	return (
		<ScrollArea
			type="auto"
			scrollbarSize={8}
			offsetScrollbars={false}
			className="plx-pluginWorkbench__contextScroll"
		>
			<Stack
				gap="sm"
				className={
					compact
						? 'plx-pluginWorkbench__contextStack plx-pluginWorkbench__contextStack--compact'
						: 'plx-pluginWorkbench__contextStack'
				}
			>
				{children}
			</Stack>
		</ScrollArea>
	)
}

export function PluginWorkbenchSidebar() {
	const { description, status } = usePluginMeta()
	const { assistVisible, setAssistHost } = usePluginWorkbenchAside()
	const views = useMemo<PluginWorkbenchView[]>(
		() => [
			{
				id: 'inspect',
				label: '概览',
				content: (
					<WorkbenchScrollPane>
						<PluginRuntimeSummaryCard description={description} status={status} />
						<PluginDependencyDetailCard />
						<ProviderPolicyCard />
						<SidebarOutlineSection visible={assistVisible} onHostChange={setAssistHost} />
					</WorkbenchScrollPane>
				),
			},
		],
		[assistVisible, description, setAssistHost, status],
	)

	return (
		<PluginWorkbenchViewContainer
			scope={SIDEBAR_VIEW_SCOPE}
			label="插件右侧视图"
			views={views}
			fallbackViewId="inspect"
			searchKey="side"
			className="plx-pluginWorkbench__contextRail"
			headerMode="inline"
		/>
	)
}

function SidebarOutlineSection({
	visible,
	onHostChange,
}: {
	visible: boolean
	onHostChange: (node: HTMLDivElement | null) => void
}) {
	const [open, setOpen] = useState(true)

	useEffect(() => {
		if (visible) setOpen(true)
	}, [visible])

	if (!visible) return null

	return (
		<Paper withBorder radius="sm" p="xs" shadow="none" className="plx-pluginWorkbench__assistCard">
			<Stack gap={8}>
				<Group justify="space-between" align="center" wrap="nowrap">
					<Text size="sm" fw={600}>
						导航
					</Text>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						aria-label={open ? '折叠目录' : '展开目录'}
						onClick={() => setOpen((value) => !value)}
					>
						<IconChevronDown
							size={16}
							style={{
								transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
								transition: 'transform 140ms ease',
							}}
						/>
					</ActionIcon>
				</Group>
				<Collapse expanded={open}>
					<div className="plx-pluginWorkbench__assistCollapse">
						<AssistHostMount onHostChange={onHostChange} />
					</div>
				</Collapse>
			</Stack>
		</Paper>
	)
}

function AssistHostMount({
	onHostChange,
}: {
	onHostChange: (node: HTMLDivElement | null) => void
}) {
	const hostRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		onHostChange(hostRef.current)
		return () => {
			onHostChange(null)
		}
	}, [onHostChange])

	return <div className="plx-pluginWorkbench__assistHost" ref={hostRef} />
}

export function PluginWorkbenchPanel() {
	const { owner } = usePluginMeta()
	const views = useMemo<PluginWorkbenchView[]>(
		() => [
			{
				id: 'logs',
				label: '日志',
				content: (
					<div className="plx-pluginWorkbench__dockPane">
						<LiveLog owner={owner} showName={false} variant="embedded" />
					</div>
				),
			},
			{
				id: 'levels',
				label: '级别',
				content: (
					<WorkbenchScrollPane compact>
						<LogLevelsCard owner={owner} compact />
					</WorkbenchScrollPane>
				),
			},
		],
		[owner],
	)

	return (
		<PluginWorkbenchViewContainer
			scope={PANEL_VIEW_SCOPE}
			label="插件底部视图"
			views={views}
			fallbackViewId="logs"
			searchKey="dock"
			className="plx-pluginWorkbench__dock"
			headerMode="inline"
		/>
	)
}
