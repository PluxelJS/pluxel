import { Divider, Group, Stack, Text } from '@mantine/core'
import type { CSSProperties, ReactNode } from 'react'

interface PluginSectionProps {
	title?: ReactNode
	actions?: ReactNode
	children?: ReactNode
	gap?: number | string
	withDivider?: boolean
	grow?: boolean
}

export function PluginSection({
	title,
	actions,
	children,
	gap = 'sm',
	withDivider = false,
	grow = false,
}: PluginSectionProps) {
	const stackStyle: CSSProperties = { minWidth: 0 }
	if (grow) {
		stackStyle.flex = '1 1 auto'
		stackStyle.minHeight = 0
	}

	const contentStyle: CSSProperties = { minWidth: 0 }
	if (grow) {
		contentStyle.flex = 1
		contentStyle.minHeight = 0
		contentStyle.display = 'flex'
		contentStyle.flexDirection = 'column'
	}

	return (
		<Stack gap={gap} style={stackStyle}>
			{withDivider ? <Divider /> : null}
			{title || actions ? (
				<Group justify="space-between" align="center" wrap="nowrap">
					{typeof title === 'string' ? (
						<Text fw={600} size="sm">
							{title}
						</Text>
					) : (
						title
					)}
					{actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
				</Group>
			) : null}
			<div style={contentStyle}>{children}</div>
		</Stack>
	)
}
