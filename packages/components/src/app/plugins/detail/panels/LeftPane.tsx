import {
	ActionIcon,
	Badge,
	Box,
	Collapse,
	Divider,
	Group,
	ScrollArea,
	Paper,
	Stack,
	Text,
	Tooltip,
} from '@mantine/core'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { LiveLog as LiveLogRaw } from '../../../log_viewer/LiveLog'
import { RouterLinkAdapter } from '../../../RouterLinkAdapter'
import { ExtensionSlot } from '../../../../extension'
import { usePluginMeta } from '../context'
import { ActionBar, ExtensionDiagnosticsCard, PluginPanel, PluginSourceCard } from '../components'

const LiveLog = memo(LiveLogRaw)

interface LeftPaneProps {
	compact?: boolean
}

function useStoredBoolean(key: string | null, fallback: boolean) {
	const [state, setState] = useState(fallback)

	useEffect(() => {
		if (!key) {
			setState(fallback)
			return
		}
		if (typeof window === 'undefined') return
		try {
			const raw = window.localStorage.getItem(key)
			if (raw == null) {
				setState(fallback)
			} else {
				setState(raw === '1' || raw === 'true')
			}
		} catch {
			setState(fallback)
		}
	}, [key, fallback])

	useEffect(() => {
		if (!key) return
		if (typeof window === 'undefined') return
		try {
			window.localStorage.setItem(key, state ? '1' : '0')
		} catch {}
	}, [key, state])

	return [state, setState] as const
}

function SectionToggle({
	onClick,
	open,
	ariaLabel,
	children,
	right,
}: {
	onClick: () => void
	open: boolean
	ariaLabel: string
	children: ReactNode
	right?: ReactNode
}) {
	return (
		<Box
			component="button"
			type="button"
			onClick={onClick}
			style={{
				display: 'flex',
				width: '100%',
				alignItems: 'center',
				gap: 8,
				cursor: 'pointer',
				userSelect: 'none',
				background: 'transparent',
				border: 'none',
				padding: 0,
				textAlign: 'left',
			}}
			aria-expanded={open}
			aria-label={ariaLabel}
		>
			<Group gap="xs" align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
				{children}
			</Group>
			{right}
			<ActionIcon variant="subtle" component="span" aria-hidden="true">
				{open ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
			</ActionIcon>
		</Box>
	)
}

export function LeftPane({ compact = false }: LeftPaneProps) {
	const { pluginName, description, isRunning, isSyncing } = usePluginMeta()
	const storageKey = useMemo(
		() => (pluginName ? `pluxel:plugin:${pluginName}:details-open` : null),
		[pluginName],
	)
	const extensionsStorageKey = useMemo(
		() => (pluginName ? `pluxel:plugin:${pluginName}:extensions-open` : null),
		[pluginName],
	)
	const [detailsOpen, setDetailsOpen] = useStoredBoolean(storageKey, true)
	const [extensionsOpen, setExtensionsOpen] = useStoredBoolean(extensionsStorageKey, true)

	const toggleDetails = useCallback(() => {
		setDetailsOpen((prev) => !prev)
	}, [])

	const toggleExtensions = useCallback(() => {
		setExtensionsOpen((prev) => !prev)
	}, [])

	const statusBadges = useMemo(
		() => (
			<Group gap="xs" wrap="nowrap">
				<Badge variant="light" color={isRunning ? 'green' : 'gray'} radius="sm">
					{isRunning ? '运行中' : '已停止'}
				</Badge>
				{isSyncing ? (
					<Badge variant="dot" color="blue" radius="sm">
						同步中…
					</Badge>
				) : null}
			</Group>
		),
		[isRunning, isSyncing],
	)

	return (
		<PluginPanel
			padding="sm"
			gap="sm"
			title={
				<Text fw={600} size="lg" lineClamp={1}>
					{pluginName}
				</Text>
			}
			rightSection={<ActionBar />}
		>
			<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
				<Paper withBorder radius="md" p="sm" shadow="xs" style={{ overflow: 'hidden' }}>
					<Group justify="space-between" align="center">
						<SectionToggle
							onClick={toggleDetails}
							open={detailsOpen}
							ariaLabel={detailsOpen ? '收起插件详情' : '展开插件详情'}
							right={<div style={{ marginLeft: 'auto', flexShrink: 0 }}>{statusBadges}</div>}
						>
							<Text size="sm" fw={600}>
								插件详情
							</Text>
							<Box style={{ flex: 1, minWidth: 0 }}>
								{description ? (
									<Tooltip label={description} multiline maw={320}>
										<Text size="xs" c="dimmed" lineClamp={1}>
											{description}
										</Text>
									</Tooltip>
								) : (
									<Text size="xs" c="dimmed">
										暂无描述
									</Text>
								)}
							</Box>
						</SectionToggle>
					</Group>
					<Collapse in={detailsOpen}>
						<Stack gap="sm" mt="sm">
							<PluginSourceCard LinkComponent={RouterLinkAdapter} />
							<ExtensionDiagnosticsCard />
						</Stack>
					</Collapse>
				</Paper>

				<ExtensionSlot
					point="plugin:info"
					wrapper={(nodes) => {
						const list = (Array.isArray(nodes) ? nodes : [nodes]).filter(Boolean)
						if (list.length === 0) return null
						return (
							<Box style={{ width: '100%' }}>
								<SectionToggle
									onClick={toggleExtensions}
									open={extensionsOpen}
									ariaLabel={extensionsOpen ? '收起扩展信息' : '展开扩展信息'}
								>
									<Text size="sm" fw={600}>
										扩展信息
									</Text>
								</SectionToggle>
								<Collapse in={extensionsOpen}>
									<ScrollArea type="auto" scrollbarSize={8} offsetScrollbars={false} mah={320}>
										<Stack gap="sm" style={{ width: '100%', paddingTop: 8 }}>
											{list}
										</Stack>
									</ScrollArea>
								</Collapse>
							</Box>
						)
					}}
					fallback={null}
				/>

				<Divider label="实时日志" labelPosition="left" />
				<Box style={{ flex: 1, minHeight: 0, display: 'flex' }}>
					<Paper
						withBorder
						p="sm"
						radius="md"
						shadow="xs"
						style={{
							flex: 1,
							minHeight: compact ? 220 : 320,
							display: 'flex',
							flexDirection: 'column',
							minWidth: 0,
						}}
					>
						<div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
							<LiveLog module={pluginName} showName={false} variant="embedded" />
						</div>
					</Paper>
				</Box>
			</Stack>
		</PluginPanel>
	)
}
