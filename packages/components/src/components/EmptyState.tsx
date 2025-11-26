import { Box, Center, Stack, Text, Title, useComputedColorScheme } from '@mantine/core'
import type { ReactNode } from 'react'
import { getPatternStyle } from '../patterns'

export interface EmptyStateProps {
	icon?: ReactNode
	title: string
	description?: string
	action?: ReactNode
	/** 是否使用 pattern 背景样式 */
	withPattern?: boolean
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
	withPattern = false,
	withBorder = false,
	minHeight = 200,
}: EmptyStateProps) {
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const isDark = scheme === 'dark'
	const pattern = withPattern ? getPatternStyle(isDark ? 'dark' : 'light') : null

	// 默认使用柔和的半透明背景，视觉上更统一
	const defaultBg = isDark ? 'rgba(30, 41, 59, 0.5)' : 'rgba(248, 250, 252, 0.8)'

	const borderStyle = withBorder
		? {
				border: `1px solid ${isDark ? 'rgba(148,163,184,0.2)' : 'rgba(15,23,42,0.08)'}`,
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
				{icon && (
					<Box
						style={{
							width: 56,
							height: 56,
							borderRadius: '50%',
							background: scheme === 'dark' ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.1)',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							color: 'var(--mantine-color-indigo-5)',
						}}
					>
						{icon}
					</Box>
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
		</Center>
	)
}
