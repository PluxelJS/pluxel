import { Box, Center, Stack, Text, Title } from '@mantine/core'
import type { ReactNode } from 'react'
import { usePlxScheme } from '../theme'

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
	const scheme = usePlxScheme()
	const patternTokens = withPattern ? scheme.pattern : null
	const emptyTokens = scheme.state.empty

	const borderStyle = withBorder
		? {
				border: `1px solid ${emptyTokens.border}`,
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
				backgroundColor: patternTokens ? patternTokens.backgroundColor : emptyTokens.bg,
				...(patternTokens
					? {
							backgroundImage: patternTokens.backgroundImage,
							backgroundSize: patternTokens.backgroundSize,
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
							background: emptyTokens.iconBg,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							color: emptyTokens.iconColor,
						}}
					>
						{icon}
					</Box>
				)}
				<Stack align="center" gap={4}>
					<Title order={5} ta="center" c={emptyTokens.titleColor}>
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
