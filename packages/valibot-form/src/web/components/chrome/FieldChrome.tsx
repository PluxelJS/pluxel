import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'
import type { ReactNode } from 'react'

export interface FieldChromeProps {
	label: string
	required?: boolean
	description?: string
	help?: string
	hint?: string
	badge?: string | { label: string; color?: string }
	errors?: string[]
	errorId?: string
	children: ReactNode
	hideLabel?: boolean
	hideRequired?: boolean
}

function BadgeNode({ badge }: { badge?: FieldChromeProps['badge'] }) {
	if (!badge) return null
	if (typeof badge === 'string') {
		return (
			<Badge variant="light" size="sm">
				{badge}
			</Badge>
		)
	}
	return (
		<Badge variant="light" size="sm" color={badge.color ?? 'gray'}>
			{badge.label}
		</Badge>
	)
}

export function FieldChrome({
	label,
	required,
	description,
	help,
	hint,
	badge,
	errors,
	errorId,
	children,
	hideLabel,
	hideRequired,
}: FieldChromeProps) {
	const errorText = (errors ?? [])
		.map((e) => e?.trim())
		.filter(Boolean)
		.join('\n')
	const showRequired = required && !hideRequired

	const labelContent = hideLabel ? null : (
		<Group gap={6} align="center" wrap="nowrap">
			<Text fw={600} size="sm">
				{label}
				{showRequired ? (
					<Text span c="red">
						{' '}
						*
					</Text>
				) : null}
			</Text>
			<BadgeNode badge={badge} />
			{hint ? (
				<Tooltip label={hint}>
					<ActionIcon size="sm" variant="subtle" color="gray" aria-label="字段提示" type="button">
						<IconInfoCircle size={14} />
					</ActionIcon>
				</Tooltip>
			) : null}
		</Group>
	)

	return (
		<Stack gap="xs" style={{ width: '100%' }}>
			{labelContent}
			{description ? (
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			) : null}
			{children}
			{errorText ? (
				<Text id={errorId} size="sm" c="red.6" style={{ whiteSpace: 'pre-line' }}>
					{errorText}
				</Text>
			) : null}
			{help ? (
				<Text size="sm" c="dimmed">
					{help}
				</Text>
			) : null}
		</Stack>
	)
}
