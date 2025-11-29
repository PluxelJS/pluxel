import { Box, Button, Center, Stack, Text, Title, useComputedColorScheme } from '@mantine/core'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { getPatternStyle } from '../patterns'

export interface ErrorStateProps {
	icon?: ReactNode
	title?: string
	message?: string
	onRetry?: () => void
	retryLabel?: string
	/** 是否使用 pattern 背景样式 */
	withPattern?: boolean
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
	withPattern = false,
	withBorder = false,
	minHeight = 200,
}: ErrorStateProps) {
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const isDark = scheme === 'dark'
	const pattern = withPattern ? getPatternStyle(isDark ? 'dark' : 'light') : null

	// 错误状态使用带有红色调的半透明背景
	const defaultBg = isDark ? 'rgba(50, 30, 30, 0.5)' : 'rgba(254, 242, 242, 0.8)'

	const borderStyle = withBorder
		? {
				border: `1px solid ${isDark ? 'rgba(248,113,113,0.3)' : 'rgba(239,68,68,0.2)'}`,
				borderRadius: 'var(--mantine-radius-lg)',
			}
		: {
				borderRadius: 'var(--mantine-radius-md)',
			}

	return (
		<Center
			style={{
				minHeight,
				width: '100%',
				padding: 'var(--mantine-spacing-xl)',
				backgroundColor: pattern ? pattern.backgroundColor : defaultBg,
				...(pattern
					? {
							backgroundImage: pattern.backgroundImage,
							backgroundSize: pattern.backgroundSize,
							backgroundPosition: pattern.backgroundPosition,
						}
					: {}),
				...borderStyle,
				transition: 'opacity 150ms ease, background-color 150ms ease',
			}}
		>
			<Stack align="center" gap="md" maw={400}>
				<Box
					style={{
						width: 56,
						height: 56,
						borderRadius: '50%',
						background: scheme === 'dark' ? 'rgba(248,113,113,0.15)' : 'rgba(239,68,68,0.1)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						color: 'var(--mantine-color-red-5)',
					}}
				>
					{icon || <IconAlertTriangle size={28} stroke={1.5} />}
				</Box>
				<Stack align="center" gap={4}>
					<Title order={5} ta="center" c="red.6">
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
						variant="light"
						color="red"
						size="sm"
						leftSection={<IconRefresh size={16} />}
						onClick={onRetry}
						mt="xs"
					>
						{retryLabel}
					</Button>
				)}
			</Stack>
		</Center>
	)
}
