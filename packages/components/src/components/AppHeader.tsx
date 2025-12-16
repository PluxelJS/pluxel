// src/components/Layout/AppHeader.tsx

import { ActionIcon, Badge, Box, Divider, Group, Stack, Text, Title } from '@mantine/core'
import { IconBell, IconDots, IconMenu2 } from '@tabler/icons-react'
import type React from 'react'
import { ColorSchemeToggle } from './ColorSchemeToggle'

export interface AppHeaderProps {
	title?: React.ReactNode
	subtitle?: React.ReactNode
	right?: React.ReactNode
	withDivider?: boolean
	showBurger?: boolean
	status?: string
	onBurgerClick?: () => void
}

export default function AppHeader({
	title = '这里是 AppHeader',
	subtitle,
	right,
	withDivider = false,
	showBurger = false,
	status,
	onBurgerClick,
}: AppHeaderProps) {
	const defaultRight = (
		<Group gap="xs">
			<ColorSchemeToggle />
			<ActionIcon variant="default" size="lg" radius="xl" aria-label="查看通知">
				<IconBell size={18} />
			</ActionIcon>
			<ActionIcon variant="default" size="lg" radius="xl" aria-label="更多操作">
				<IconDots size={18} />
			</ActionIcon>
		</Group>
	)

	return (
		<Box component="header" h="100%" role="banner">
			<Group px="md" h="100%" wrap="nowrap" gap="md" style={{ minWidth: 0 }}>
				{showBurger && (
					<ActionIcon
						variant="subtle"
						size="lg"
						radius="xl"
						onClick={onBurgerClick}
						aria-label="展开导航"
					>
						<IconMenu2 size={18} />
					</ActionIcon>
				)}

				<Stack gap={2} style={{ minWidth: 0 }}>
					<Group gap={8}>
						<Title
							order={3}
							fw={600}
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
						{status && (
							<Badge color="brand" variant="light">
								{status}
							</Badge>
						)}
					</Group>
					{subtitle && (
						<Text size="sm" c="dimmed" lineClamp={1}>
							{subtitle}
						</Text>
					)}
				</Stack>

				<Box ml="auto" style={{ minWidth: 0 }}>
					{right ?? defaultRight}
				</Box>
			</Group>

			{withDivider && <Divider />}
		</Box>
	)
}
