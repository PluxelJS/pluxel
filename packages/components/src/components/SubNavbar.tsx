import { Avatar, Badge, Button, Group, NavLink, Paper, Stack, Text } from '@mantine/core'
import React from 'react'

export interface SubNavItem {
	label: string
	description?: string
	badge?: React.ReactNode
	active?: boolean
	onClick?: () => void
}

export interface SubNavBarProps {
	title?: string
	description?: string
	items?: Array<string | SubNavItem>
	activeIndex?: number
	userName?: string
	userEmail?: string
	onLogout?: () => void
}

export default function SubNavBar({
	title = '子导航标题',
	description = '筛选你常用的子功能',
	items = ['子项一', '子项二', '子项三'],
	activeIndex,
	userName = '用户名',
	userEmail = 'user@example.com',
	onLogout,
}: SubNavBarProps) {
	const normalizedItems: SubNavItem[] = items.map((item) =>
		typeof item === 'string' ? { label: item } : item,
	)

	return (
		<Stack w={260} p="md" gap="lg">
			<Stack gap={4}>
				<Text fz={20} fw={600}>
					{title}
				</Text>
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			</Stack>

			<Stack gap="xs">
				{normalizedItems.map((item, index) => {
					const active = item.active ?? activeIndex === index
					return (
						<NavLink
							key={item.label}
							active={active}
							label={
								<Stack gap={2} style={{ lineHeight: 1.2 }}>
									<Text fw={600}>{item.label}</Text>
									{item.description && (
										<Text size="xs" c="dimmed">
											{item.description}
										</Text>
									)}
								</Stack>
							}
							rightSection={
								item.badge ??
								(active ? (
									<Badge color="brand" size="xs" variant="light">
										进行中
									</Badge>
								) : undefined)
							}
							onClick={item.onClick}
							styles={{
								root: {
									borderRadius: 12,
								},
							}}
						/>
					)
				})}
			</Stack>

			<Paper withBorder>
				<Group align="flex-start" wrap="nowrap">
					<Avatar radius="xl" color="brand">
						{userName?.slice(0, 1) ?? 'U'}
					</Avatar>
					<div style={{ flex: 1, minWidth: 0 }}>
						<Text fw={600}>{userName}</Text>
						<Text size="sm" c="dimmed">
							{userEmail}
						</Text>
					</div>
					<Button variant="light" size="xs" onClick={onLogout}>
						登出
					</Button>
				</Group>
			</Paper>
		</Stack>
	)
}
