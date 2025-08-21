// src/plugins/PluginsLayout.tsx
import type React from 'react'
import { useEffect } from 'react'
import {
	Stack,
	Group,
	Card,
	CardSection,
	Title,
	Text,
	Divider,
	ScrollArea,
	Button,
	Drawer,
	Center,
	useMantineTheme,
	Box,
} from '@mantine/core'
import { useDisclosure, useMediaQuery } from '@mantine/hooks'
import { useRoute } from 'wouter'
import { PluginList } from './PluginList'
import { Plugin } from './Plugin'
import { ClientOnly } from '../ClientOnly'

export const PluginsLayout: React.FC = () => {
	const [match, params] = useRoute<{ name?: string }>('/plugins/:name')
	const pluginName = match ? params.name : undefined

	const theme = useMantineTheme()
	const isSmall = useMediaQuery(
		`(max-width: ${theme.breakpoints.md})`,
		undefined,
		{
			getInitialValueInEffect: true,
		},
	)
	const [opened, { open, close, toggle }] = useDisclosure(false)

	useEffect(() => {
		if (isSmall && pluginName) close()
	}, [isSmall, pluginName, close])

	const sidebarWidth = 'clamp(180px, 22vw, 240px)'

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
					<Card
						w={sidebarWidth}
						style={{
							flex: '0 0 auto',
							display: 'flex',
							flexDirection: 'column',
							minHeight: 0,
						}}
					>
						<CardSection withBorder px="md" py="sm">
							<Group justify="space-between" wrap="nowrap">
								<Title order={6}>插件列表</Title>
							</Group>
						</CardSection>

						<CardSection
							px="md"
							py="sm"
							style={{ flex: 1, minHeight: 0, display: 'flex' }}
						>
							{/* 唯一滚动层：左栏自己的滚动，不受右栏影响 */}
							<ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
								<PluginList pluginName={pluginName} />
							</ScrollArea>
						</CardSection>
					</Card>
				)}

				{/* 右栏：主内容（包一层 ScrollArea，独立滚动） */}
				<Box
					// 关键：右栏外层先截断溢出，防止把父容器“顶高”
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
						<ClientOnly>
							<Plugin key={pluginName} pluginName={pluginName} />
						</ClientOnly>
					) : (
						<Center style={{ flex: 1 }}>
							<Text c="dimmed" size="lg">
								请选择一个插件以查看详情
							</Text>
						</Center>
					)}
				</Box>
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
			>
				<Stack gap="sm" style={{ height: '100%', minHeight: 0 }}>
					<Divider label="浏览与分组" />
					<ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
						<PluginList />
					</ScrollArea>
				</Stack>
			</Drawer>
		</Stack>
	)
}
