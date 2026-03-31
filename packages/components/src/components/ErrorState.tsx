import { Box, Button, Center, Stack, Text, Title } from '@mantine/core'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { usePlxScheme } from '../theme'

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
	const scheme = usePlxScheme()
	const pattern = withPattern ? scheme.pattern : null
	const errorTokens = scheme.state.error

	const borderStyle = withBorder
		? {
				border: `1px solid ${errorTokens.border}`,
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
				backgroundColor: pattern ? pattern.backgroundColor : errorTokens.bg,
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
						background: errorTokens.iconBg,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						color: errorTokens.iconColor,
					}}
				>
					{icon || <IconAlertTriangle size={28} stroke={1.5} />}
				</Box>
				<Stack align="center" gap={4}>
					<Title order={5} ta="center" c={errorTokens.titleColor}>
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
						variant="subtle"
						size="sm"
						leftSection={<IconRefresh size={16} />}
						onClick={onRetry}
						mt="xs"
						style={{
							background: errorTokens.iconBg,
							border: `1px solid ${errorTokens.border}`,
							color: errorTokens.titleColor,
						}}
					>
						{retryLabel}
					</Button>
				)}
			</Stack>
		</Center>
	)
}
