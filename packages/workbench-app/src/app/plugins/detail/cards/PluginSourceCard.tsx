import {
	ActionIcon,
	Badge,
	Box,
	CopyButton,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
	useMantineTheme,
} from '@mantine/core'
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useMemo, type ReactNode } from 'react'
import { usePluginScope, type PluginSourceInfo } from '../context'
import { shortenPathSegments } from '../rightPaneState'
import {
	DependencyList,
	usePluginDependencyEntries,
	type DependencyListProps,
} from './DependencyList'

function CopyAction({ value, label = '复制路径' }: { value: string | null; label?: string }) {
	if (value == null || value === '') return null
	return (
		<CopyButton value={value}>
			{({ copied, copy }) => (
				<Tooltip label={copied ? '已复制' : label} withArrow>
					<ActionIcon size="sm" variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>
						{copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
					</ActionIcon>
				</Tooltip>
			)}
		</CopyButton>
	)
}

function renderSourceContent(source: PluginSourceInfo, themeColor: string): ReactNode {
	switch (source.kind) {
		case 'hmr': {
			const fullPath = source.moduleId
			const preview = fullPath ? shortenPathSegments(fullPath) : '未提供路径'
			return (
				<Group gap="xs" wrap="nowrap" align="center">
					<Tooltip label={fullPath ?? '路径未知'} withArrow>
						<Text
							size="sm"
							lh={1.4}
							style={{
								fontFamily: 'var(--mantine-font-monospace)',
								color: themeColor,
								wordBreak: 'break-all',
								maxWidth: '100%',
							}}
						>
							{preview}
						</Text>
					</Tooltip>
					<CopyAction value={fullPath} />
				</Group>
			)
		}
		case 'package': {
			const revision = source.version ?? source.tag ?? ''
			const versionToken = revision ? `@${revision}` : ''
			const display = `${source.packageName}${versionToken}`
			return (
				<Group gap="xs" wrap="nowrap">
					<Text size="sm" fw={600}>
						{display}
					</Text>
					<CopyAction value={source.moduleId} label="复制模块路径" />
				</Group>
			)
		}
		default: {
			return (
				<Group gap="xs" wrap="nowrap">
					<Text size="sm" c="dimmed">
						来源未知
					</Text>
					<CopyAction value={source.moduleId} />
				</Group>
			)
		}
	}
}

function getBadgeLabel(source: PluginSourceInfo): { label: string; color: string } {
	switch (source.kind) {
		case 'hmr':
			return { label: 'HMR 模块', color: 'blue' }
		case 'package':
			return { label: '包管理安装', color: 'green' }
		default:
			return { label: '未知来源', color: 'gray' }
	}
}

export interface PluginSourceCardProps {
	LinkComponent?: DependencyListProps['LinkComponent']
}

export function PluginSourceCard({ LinkComponent }: PluginSourceCardProps) {
	const { source } = usePluginScope()
	const theme = useMantineTheme()
	const badge = getBadgeLabel(source)
	const accent = theme.colors[theme.primaryColor]?.[6] ?? theme.colors.blue?.[6] ?? theme.black
	const dependencies = usePluginDependencyEntries()

	const content = useMemo(() => renderSourceContent(source, accent), [source, accent])
	const labelStyle = { width: 44, flexShrink: 0 }

	return (
		<Stack gap="sm">
			<Paper withBorder radius="sm" p="sm" shadow="none">
				<Stack gap="xs">
					<Group gap="xs" align="flex-start" wrap="nowrap">
						<Text size="xs" c="dimmed" fw={600} style={labelStyle}>
							来源
						</Text>
						<Badge variant="light" color={badge.color} size="sm" radius="sm">
							{badge.label}
						</Badge>
						<Box style={{ flex: 1, minWidth: 0 }}>{content}</Box>
					</Group>

					<Group gap="xs" align="flex-start" wrap="nowrap">
						<Text size="xs" c="dimmed" fw={600} style={labelStyle}>
							依赖
						</Text>
						<Badge variant="light" size="sm" color="gray" radius="sm">
							{dependencies.length}
						</Badge>
						<Box style={{ flex: 1, minWidth: 0 }}>
							<DependencyList LinkComponent={LinkComponent} />
						</Box>
					</Group>
				</Stack>
			</Paper>
		</Stack>
	)
}
