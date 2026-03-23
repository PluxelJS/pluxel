// src/plugins/PluginsLayout.tsx

import {
	Box,
	Button,
	Drawer,
	Group,
	Paper,
	Stack,
	Text,
	Title,
	useComputedColorScheme,
	useMantineTheme,
} from '@mantine/core'
import { useDisclosure, useMediaQuery } from '@mantine/hooks'
import { IconPuzzle } from '@tabler/icons-react'
import type React from 'react'
import { useEffect, useMemo } from 'react'
import { Outlet } from '@tanstack/react-router'
import { EmptyState } from '../../../components'
import { PluginList } from './PluginList'
import { useCurrentPathname } from '../../router/useCurrentRoute'

export const PluginsLayout: React.FC = () => {
	const pathname = useCurrentPathname()
	const pluginName = useMemo(() => {
		const match = pathname.match(/^\/plugins\/([^/]+)/)
		if (!match?.[1]) return undefined
		try {
			return decodeURIComponent(match[1])
		} catch {
			return match[1]
		}
	}, [pathname])

	const theme = useMantineTheme()
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const isSmall = useMediaQuery(`(max-width: ${theme.breakpoints.md})`, undefined, {
		getInitialValueInEffect: true,
	})
	const [opened, { close, toggle }] = useDisclosure(false)

	useEffect(() => {
		if (isSmall && pluginName) close()
	}, [isSmall, pluginName, close])

	const sidebarWidth = 'clamp(220px, 24vw, 320px)'

	return (
		// 关键：根层必须“封顶”并禁止向外溢出，这样页面不滚，只在内部滚
		<Stack gap="md" h="100%" style={{ minHeight: 0, overflow: 'hidden' }}>
			{/* 顶部工具条（仅小屏） */}
			{isSmall && (
				<Group justify="space-between">
					<Button variant="light" onClick={toggle}>
						浏览插件
					</Button>
					<Text c="dimmed" size="sm" lineClamp={1}>
						{pluginName ? `当前：${pluginName}` : '请选择一个插件'}
					</Text>
				</Group>
			)}

			{/* 主体：两列布局（桌面）；单列（移动） */}
			<Group
				gap="md"
				wrap="nowrap"
				align="stretch"
				// 关键：中间主容器同样封顶且不外溢
				style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}
			>
				{/* 左栏：桌面常驻 + 独立滚动 */}
				{!isSmall && (
					<Paper
						w={sidebarWidth}
						withBorder
						radius="xl"
						px="md"
						py="sm"
						style={{
							flex: '0 0 auto',
							display: 'flex',
							flexDirection: 'column',
							minHeight: 0,
						}}
					>
						<Group justify="space-between" mb="sm">
							<Title order={5}>插件浏览</Title>
							<Text size="xs" c="dimmed">
								智能分组
							</Text>
						</Group>
						<Box style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
							<PluginList pluginName={pluginName} />
						</Box>
					</Paper>
				)}

				{/* 右栏：主内容（内部自行处理滚动） */}
				<Paper
					withBorder
					radius="xl"
					p="md"
					style={{
						flex: 1,
						minWidth: 0,
						minHeight: 0,
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
					}}
				>
					{pluginName ? (
						<Outlet />
					) : (
						<EmptyState
							icon={<IconPuzzle size={28} stroke={1.5} />}
							title="还没有选择插件"
							description="从左侧列表挑选一个插件，查看运行状态与设置。"
							withPattern
							minHeight="100%"
						/>
					)}
				</Paper>
			</Group>

			{/* 移动端抽屉：左栏 */}
			<Drawer
				opened={opened}
				onClose={close}
				position="left"
				size="100%"
				padding="md"
				title="插件"
				keepMounted
				styles={{
						content: {
							background: colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
						},
					}}
			>
				<Stack gap="sm" style={{ height: '100%', minHeight: 0 }}>
					<Box style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
						<PluginList pluginName={pluginName} />
					</Box>
				</Stack>
			</Drawer>
		</Stack>
	)
}
