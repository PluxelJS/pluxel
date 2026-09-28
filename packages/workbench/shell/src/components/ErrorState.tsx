import { Button, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import type { CSSProperties, ReactNode } from 'react'

export interface ErrorStateProps {
	icon?: ReactNode
	title?: string
	message?: string
	onRetry?: () => void
	retryLabel?: string
	/** 是否带边框 */
	withBorder?: boolean
	/** 最小高度 */
	minHeight?: number | string
}

export function ErrorState({
	icon,
	title = '加载失败',
	message = '无法加载数据，请稍后重试',
	onRetry,
	retryLabel = '重试',
	withBorder = false,
	minHeight = 200,
}: ErrorStateProps) {
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
				<ThemeIcon size={56} radius="xl" variant="light" color="red">
					{icon || <IconAlertTriangle size={28} stroke={1.5} />}
				</ThemeIcon>
				<Stack align="center" gap={4}>
					<Title order={5} ta="center">
						{title}
					</Title>
					{message && (
						<Text size="sm" c="dimmed" ta="center">
							{message}
						</Text>
					)}
				</Stack>
				{onRetry && (
					<Button
						size="sm"
						leftSection={<IconRefresh size={16} />}
						onClick={onRetry}
						mt="xs"
						color="red"
						variant="light"
					>
						{retryLabel}
					</Button>
				)}
			</Stack>
		</Paper>
	)
}
