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
import type { WorkbenchNavigationRequest } from '../../../workbench/context'
import { usePluginScope, type PluginSourceInfo } from '../context'
import {
	DependencyList,
	usePluginDependencyEntries,
	type DependencyListProps,
} from './DependencyList'
import { BaseProviderCard } from './BaseProviderCard'
import { DependencyOverridesCard } from './DependencyOverridesCard'

function shortenPath(path: string, keep = 3) {
	const segments = path.split(/[/\\]+/).filter(Boolean)
	if (segments.length <= keep) return path
	return `…/${segments.slice(-keep).join('/')}`
}

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
			const preview = fullPath ? shortenPath(fullPath) : '未提供路径'
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
	linkWorkbenchMode?: WorkbenchNavigationRequest
}

export function PluginSourceCard({ LinkComponent, linkWorkbenchMode }: PluginSourceCardProps) {
	const { source, knownPluginNames } = usePluginScope()
	const theme = useMantineTheme()
	const badge = getBadgeLabel(source)
	const accent = theme.colors[theme.primaryColor]?.[6] ?? theme.colors.blue?.[6] ?? theme.black
	const dependencies = usePluginDependencyEntries()

	const content = useMemo(() => renderSourceContent(source, accent), [source, accent])
	const labelStyle = { width: 44, flexShrink: 0 }
	const isLinkable = useMemo(() => {
		return (name: string) => {
			if (knownPluginNames.has(name)) return true
			const hash = name.lastIndexOf('#')
			if (hash > 0) return knownPluginNames.has(name.slice(0, hash))
			return false
		}
	}, [knownPluginNames])

	return (
		<Stack gap="sm">
			<BaseProviderCard />
			<Paper withBorder radius="md" p="sm" shadow="xs">
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
							<DependencyList
								LinkComponent={LinkComponent}
								isLinkable={isLinkable}
								linkWorkbenchMode={linkWorkbenchMode}
							/>
						</Box>
					</Group>
				</Stack>
			</Paper>

			{/* DI 选择存在“条件渲染”，避免加载期间闪烁导致布局重排 */}
			<DependencyOverridesCard />
		</Stack>
	)
}
