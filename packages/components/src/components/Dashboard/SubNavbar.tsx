import React from 'react'
import { Flex, Text, Button } from '@mantine/core'

export interface SubNavBarProps {
	title?: string
	items?: string[]
	userName?: string
	userEmail?: string
	onLogout?: () => void
}

export default function SubNavBar({
	title = '子导航标题',
	items = ['子项一', '子项二', '子项三'],
	userName = '用户名',
	userEmail = 'user@example.com',
	onLogout,
}: SubNavBarProps) {
	return (
		<Flex direction="column" align="start" w={217} px="md" py="sm">
			<Text fz={20} fw={600}>
				{title}
			</Text>

			<Flex flex={1} gap={10} direction="column" align="start" my={30} w="100%">
				{items.map((label, idx) => (
					<div key={idx}>{label}</div>
				))}
			</Flex>

			<Flex w="100%" px={10} py={10} justify="space-between" align="center">
				<Flex direction="column" align="start">
					<Text fz={14} fw={600}>
						{userName}
					</Text>
					<Text fz={12}>{userEmail}</Text>
				</Flex>
				<Button m={0} p={8} onClick={onLogout}>
					登出
				</Button>
			</Flex>
		</Flex>
	)
}
