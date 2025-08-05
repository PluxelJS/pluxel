import React, { useState } from 'react'
import { Layout } from './Layout'
import {
	PluginOrganizer,
	type PluginStatus,
	type GroupConfig,
} from '../Plugin/PluginOrganizer'
import { Flex, Box, ScrollArea } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'

const statuses: PluginStatus[] = [
	{ id: 'PluginA', isRunning: true },
	{ id: 'PluginB', isRunning: false },
	{ id: 'PluginC', isRunning: false },
]

const initialGroups: GroupConfig[] = [
	{ groupId: 'group1', name: '常用插件', pluginIds: ['PluginA', 'PluginB'] },
	{ groupId: 'group2', name: '备用插件', pluginIds: ['PluginC'] },
]

export default function App() {
	const [opened, setOpened] = useState(false)
	const handleChange = (groups: GroupConfig[]) =>
		console.log('New groups:', groups)

	// 监听屏幕宽度：小于 768px 就视作移动端
	const isMobile = useMediaQuery('(max-width: 768px)')

	return (
		<Layout opened={opened} navItems={[{ label: 'a', href: '/test' }]}>
			{/* 外层 Flex 控制两栏布局 */}
			<Flex
				direction={isMobile ? 'column' : 'row'}
				style={{
					height: 'calc(100vh - 60px)', // 根据你的 Layout header 高度调整
					width: '100%',
				}}
			>
				{/* 左侧：插件列表，固定宽度 & 可滚动 */}
				<Box
					style={{
						flexShrink: 0,
						flexBasis: isMobile ? '100%' : 240, // 小屏铺满，大屏固定 240px
					}}
				>
					<ScrollArea style={{ height: '100%' }}>
						<PluginOrganizer
							statuses={statuses}
							initialGroups={initialGroups}
							onGroupsChange={handleChange}
						/>
					</ScrollArea>
				</Box>

				{/* 右侧：主内容，占剩余空间 */}
				<Box
					style={{
						flex: 1,
						padding: isMobile ? '1rem 0' : '1rem',
						overflowY: 'auto',
					}}
				>
					<h2>主内容区域</h2>
					<button onClick={() => setOpened((o) => !o)}>
						{opened ? '关闭遮罩' : '打开遮罩'}
					</button>
					{/* 这里渲染其他内容 */}
				</Box>
			</Flex>
		</Layout>
	)
}
