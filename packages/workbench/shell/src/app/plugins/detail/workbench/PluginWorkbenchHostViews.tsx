import { Stack } from '@mantine/core'
import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { LiveLog as LiveLogRaw } from '../../../log_viewer/LiveLog'
import { usePluginMeta } from '../context'
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

/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Scroll regions need keyboard focus for Page Up/Down and arrow scrolling. */
function WorkbenchScrollPane({
	children,
	compact = false,
}: {
	children: ReactNode
	compact?: boolean
}) {
	return (
		<div
			className="plx-pluginWorkbench__contextScroll"
			tabIndex={0}
			role="region"
			aria-label="视图内容"
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
		</div>
	)
}

/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */

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
					</WorkbenchScrollPane>
				),
			},
			{
				id: 'outline',
				label: '目录',
				hidden: !assistVisible,
				content: <AssistHostMount onHostChange={setAssistHost} />,
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
