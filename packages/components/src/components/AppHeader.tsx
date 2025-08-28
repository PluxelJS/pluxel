// src/components/Layout/AppHeader.tsx

import { Box, Burger, Divider, Group, Title } from '@mantine/core'
import type React from 'react'

export interface AppHeaderProps {
	/** 左侧主标题（string 或自定义节点） */
	title?: React.ReactNode
	/** 右侧插槽：操作区/用户信息/搜索框等 */
	right?: React.ReactNode
	/** 是否在底部显示一条分隔线 */
	withDivider?: boolean
	/** 移动端是否显示汉堡按钮 */
	showBurger?: boolean
	/** 点击汉堡按钮（常用于打开侧栏） */
	onBurgerClick?: () => void
}

export default function AppHeader({
	title = '这里是 AppHeader',
	right,
	withDivider = false,
	showBurger = false,
	onBurgerClick,
}: AppHeaderProps) {
	return (
		<Box component="header" h="100%" role="banner">
			<Group
				px="md"
				h="100%"
				wrap="nowrap"
				gap="sm"
				style={{ minWidth: 0 }} // 允许内部文本截断
			>
				{showBurger && <Burger size="sm" onClick={onBurgerClick} aria-label="Toggle navigation" />}

				<Title
					order={3}
					fw={600}
					// 让标题在窄屏不挤爆布局
					style={{
						fontSize: 18,
						margin: 0,
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
				>
					{title}
				</Title>

				<Box ml="auto" style={{ minWidth: 0 }}>
					{right ?? <span style={{ opacity: 0.7 }}>右侧操作区</span>}
				</Box>
			</Group>

			{withDivider && <Divider />}
		</Box>
	)
}
