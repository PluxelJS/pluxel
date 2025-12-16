import { Card, Group, Stack, Text } from '@mantine/core'
import type { CSSProperties, ReactNode } from 'react'

interface PluginPanelProps {
	title?: ReactNode
	description?: ReactNode
	rightSection?: ReactNode
	children?: ReactNode
	gap?: number | string
	padding?: number | string
	style?: CSSProperties
}

const ROOT_STYLE = {
	height: '100%',
	width: '100%',
	display: 'flex',
	flexDirection: 'column' as const,
	minHeight: 0,
	minWidth: 0,
}

const CONTENT_STYLE: CSSProperties = {
	flex: 1,
	minHeight: 0,
	minWidth: 0,
	width: '100%',
	display: 'flex',
	flexDirection: 'column',
}

export function PluginPanel({
	title,
	description,
	rightSection,
	children,
	gap = 8,
	padding = 16,
	style,
}: PluginPanelProps) {
	return (
		<Card withBorder shadow="sm" radius="lg" style={{ ...ROOT_STYLE, ...style }} p={padding}>
			<Stack gap={gap} style={{ flex: 1, minHeight: 0 }}>
				{title || description || rightSection ? (
					<Group justify="space-between" align="flex-start" wrap="nowrap" gap={12}>
						<Stack gap={2} style={{ minWidth: 0 }}>
							{typeof title === 'string' ? (
								<Text fw={600} size="lg" lineClamp={1}>
									{title}
								</Text>
							) : (
								title
							)}
							{typeof description === 'string' ? (
								<Text size="sm" c="dimmed">
									{description}
								</Text>
							) : (
								description
							)}
						</Stack>
						{rightSection && <div style={{ flexShrink: 0 }}>{rightSection}</div>}
					</Group>
				) : null}
				<div style={CONTENT_STYLE}>{children}</div>
			</Stack>
		</Card>
	)
}
