import { Box, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core'
import type { CSSProperties, ReactNode } from 'react'

export interface EmptyStateProps {
	icon?: ReactNode
	title: string
	description?: string
	action?: ReactNode
	/** 是否带边框 */
	withBorder?: boolean
	/** 最小高度 */
	minHeight?: number | string
}

export function EmptyState({
	icon,
	title,
	description,
	action,
	withBorder = false,
	minHeight = 200,
}: EmptyStateProps) {
	const surfaceStyle = {
		minHeight,
		width: '100%',
		padding: 'var(--mantine-spacing-xl)',
		alignItems: 'center',
		display: 'flex',
		justifyContent: 'center',
	} satisfies CSSProperties

	return (
		<Paper withBorder={withBorder} radius={withBorder ? 'lg' : 'md'} style={surfaceStyle}>
			<Stack align="center" gap="md" maw={400}>
				{icon && (
					<ThemeIcon size={56} radius="xl" variant="light" color="gray">
						{icon}
					</ThemeIcon>
				)}
				<Stack align="center" gap={4}>
					<Title order={5} ta="center">
						{title}
					</Title>
					{description && (
						<Text size="sm" c="dimmed" ta="center">
							{description}
						</Text>
					)}
				</Stack>
				{action && <Box mt="xs">{action}</Box>}
			</Stack>
		</Paper>
	)
}
