import {
	ActionIcon,
	Badge,
	Box,
	Collapse,
	Divider,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from '@mantine/core'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { LiveLog as LiveLogRaw } from '../../../log_viewer/LiveLog'
import { RouterLinkAdapter } from '../../../RouterLinkAdapter'
import { ExtensionSlot } from '../../../../extension'
import { usePluginMeta } from '../context'
import { ActionBar } from './ActionBar'
import { PluginPanel } from './PluginPanel'
import { PluginSourceCard } from './PluginSourceCard'

const LiveLog = memo(LiveLogRaw)

interface LeftPaneProps {
	compact?: boolean
}

export function LeftPane({ compact = false }: LeftPaneProps) {
	const { pluginName, description, isRunning, isSyncing } = usePluginMeta()
	const storageKey = useMemo(
		() => (pluginName ? `pluxel:plugin:${pluginName}:details-open` : null),
		[pluginName],
	)
	const [detailsOpen, setDetailsOpen] = useState(true)

	useEffect(() => {
		if (!storageKey) {
			setDetailsOpen(true)
			return
		}
		if (typeof window === 'undefined') return
		try {
			const raw = window.localStorage.getItem(storageKey)
			if (raw == null) {
				setDetailsOpen(true)
			} else {
				setDetailsOpen(raw === '1' || raw === 'true')
			}
		} catch {
			setDetailsOpen(true)
		}
	}, [storageKey])

	useEffect(() => {
		if (!storageKey) return
		if (typeof window === 'undefined') return
		try {
			window.localStorage.setItem(storageKey, detailsOpen ? '1' : '0')
		} catch {}
	}, [storageKey, detailsOpen])

	const toggleDetails = useCallback(() => {
		setDetailsOpen((prev) => !prev)
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
			title={
				<Text fw={600} size="lg" lineClamp={1}>
					{pluginName}
				</Text>
			}
			rightSection={<ActionBar />}
		>
			<Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
				<Paper withBorder radius="md" p="sm" shadow="xs" style={{ overflow: 'hidden' }}>
					<Group justify="space-between" align="center">
					<Box
						component="button"
						type="button"
						onClick={toggleDetails}
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
						aria-expanded={detailsOpen}
						aria-label={detailsOpen ? '收起插件详情' : '展开插件详情'}
					>
						<Group gap="xs" align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
							<Text size="sm" fw={600}>
								插件详情
							</Text>
							{statusBadges}
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
						</Group>
						<ActionIcon
							variant="subtle"
							component="span"
							aria-hidden="true"
							style={{ marginLeft: 'auto', flexShrink: 0 }}
						>
							{detailsOpen ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
						</ActionIcon>
					</Box>
					</Group>
					<Collapse in={detailsOpen}>
						<Stack gap="sm" mt="sm">
							<PluginSourceCard LinkComponent={RouterLinkAdapter} />
						</Stack>
					</Collapse>
				</Paper>

				<ExtensionSlot
					point="plugin:info"
					wrapper={(nodes) => (
						<Stack gap="sm" style={{ width: '100%' }}>
							{nodes}
						</Stack>
					)}
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
							<LiveLog module={pluginName} />
						</div>
					</Paper>
				</Box>
			</Stack>
		</PluginPanel>
	)
}
