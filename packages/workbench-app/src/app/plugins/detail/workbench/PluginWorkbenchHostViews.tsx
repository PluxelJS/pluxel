import {
	ActionIcon,
	Badge,
	Button,
	Collapse,
	CopyButton,
	Group,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
} from '@mantine/core'
import { IconAlertTriangle, IconChevronDown } from '@tabler/icons-react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { LiveLog as LiveLogRaw } from '../../../log_viewer/LiveLog'
import { usePluginMeta, usePluginScope } from '../context'
import { ProviderPolicyCard } from '../cards/ProviderPolicyCard'
import { PluginDependencyDetailCard } from '../cards/PluginDependencyDetailCard'
import { LogLevelsCard } from '../cards/LogLevelsCard'
import { describePluginControl } from '../controls/pluginControlModel'
import { formatCompactSource } from '../rightPaneState'
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

function PluginDescriptionCard({ description }: { description?: string | null }) {
	return (
		<Paper withBorder radius="sm" p="sm" shadow="none" style={{ overflow: 'hidden' }}>
			<Stack gap={4}>
				<Text size="sm" fw={600}>
					插件详情
				</Text>
				{description ? (
					<Tooltip label={description} multiline maw={320}>
						<Text size="xs" c="dimmed" lineClamp={2}>
							{description}
						</Text>
					</Tooltip>
				) : (
					<Text size="xs" c="dimmed">
						暂无描述
					</Text>
				)}
			</Stack>
		</Paper>
	)
}

export function PluginWorkbenchSidebar() {
	const { description } = usePluginMeta()
	const { assistVisible, setAssistHost } = usePluginWorkbenchAside()
	const views = useMemo<PluginWorkbenchView[]>(
		() => [
			{
				id: 'inspect',
				label: '概览',
				content: (
					<WorkbenchScrollPane>
						<PluginDescriptionCard description={description} />
						<PluginContextSummaryCard />
						<PluginDependencyDetailCard />
						<ProviderPolicyCard />
						<SidebarOutlineSection visible={assistVisible} onHostChange={setAssistHost} />
					</WorkbenchScrollPane>
				),
			},
		],
		[assistVisible, description, setAssistHost],
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

function PluginContextSummaryCard() {
	const { pluginLabel, source, status } = usePluginScope()
	const control = describePluginControl(status)
	const sourcePreview = useMemo(
		() =>
			formatCompactSource(
				source.moduleId ?? null,
				source.packageName ?? null,
				source.version ?? null,
			),
		[source.moduleId, source.packageName, source.version],
	)
	const sourceBadge = source.kind === 'hmr' ? 'HMR' : source.kind === 'package' ? '包' : '未知'
	const copyValue = source.moduleId ?? source.packageName ?? null

	return (
		<Paper withBorder radius="sm" p="sm" shadow="none">
			<Stack gap={8}>
				<div className="plx-pluginWorkbench__summaryRow">
					<span className="plx-pluginWorkbench__summaryLabel">运行</span>
					<div className="plx-pluginWorkbench__summaryValue">
						<Badge size="xs" variant="light" color={control.statusTone}>
							{control.statusLabel}
						</Badge>
						<Badge size="xs" variant="outline" color="gray">
							{control.desiredStateLabel}
						</Badge>
					</div>
				</div>

				<div className="plx-pluginWorkbench__summaryRow">
					<span className="plx-pluginWorkbench__summaryLabel">会话</span>
					<Text className="plx-pluginWorkbench__summaryText" size="sm">
						{control.sessionIntentLabel} · 激活来源：{control.activationReasonLabel}
					</Text>
				</div>

				<div className="plx-pluginWorkbench__summaryRow">
					<span className="plx-pluginWorkbench__summaryLabel">策略</span>
					<Text className="plx-pluginWorkbench__summaryText" size="sm">
						自动启动{status.autoStart ? '已开启' : '已关闭'}
					</Text>
				</div>

				<div className="plx-pluginWorkbench__summaryRow">
					<span className="plx-pluginWorkbench__summaryLabel">来源</span>
					<div className="plx-pluginWorkbench__summaryValue" data-wrap="true">
						<Badge size="xs" variant="light" color={source.kind === 'hmr' ? 'blue' : 'gray'}>
							{sourceBadge}
						</Badge>
						{copyValue ? (
							<CopyButton value={copyValue}>
								{({ copied, copy }) => (
									<Tooltip
										label={
											copied ? '已复制' : (source.moduleId ?? source.packageName ?? '未知来源')
										}
										multiline
										maw={360}
									>
										<Button
											type="button"
											variant="subtle"
											size="compact-xs"
											className="plx-pluginWorkbench__metaChip"
											onClick={copy}
										>
											{sourcePreview}
										</Button>
									</Tooltip>
								)}
							</CopyButton>
						) : (
							<Text className="plx-pluginWorkbench__summaryText" size="sm">
								{sourcePreview}
							</Text>
						)}
					</div>
				</div>

				<Group gap={6} wrap="wrap">
					<Badge size="xs" variant="light" color="gray">
						{pluginLabel}
					</Badge>
				</Group>

				{status.issues.length > 0 ? (
					<Stack gap={4} className="plx-pluginWorkbench__statusIssues">
						<Group gap={5} wrap="nowrap">
							<IconAlertTriangle size={14} color="var(--mantine-color-yellow-7)" />
							<Text size="xs" fw={650}>
								{status.issues.length} 项协调问题
							</Text>
						</Group>
						{status.issues.map((issue) => (
							<Text key={issue.id} size="xs" c="dimmed">
								{issue.message}
							</Text>
						))}
					</Stack>
				) : null}
			</Stack>
		</Paper>
	)
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
