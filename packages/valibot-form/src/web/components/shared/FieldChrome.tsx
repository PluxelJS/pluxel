import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'
import type { ReactNode } from 'react'

export interface FieldChromeProps {
	label: string
	required?: boolean
	description?: string
	helperText?: string
	hint?: string
	tooltip?: string
	badge?: string | { label: string; color?: string }
	errors?: string[]
	children: ReactNode
	hideLabel?: boolean
	hideRequired?: boolean
	inlineLabel?: boolean
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
	helperText,
	hint,
	tooltip,
	badge,
	errors,
	children,
	hideLabel,
	hideRequired,
	inlineLabel,
}: FieldChromeProps) {
	const errorText = (errors ?? []).map((e) => e?.trim()).filter(Boolean).join('\n')
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
			{tooltip ? (
				<Tooltip label={tooltip}>
					<ActionIcon size="sm" variant="subtle" color="gray" aria-label="字段提示">
						<IconInfoCircle size={14} />
					</ActionIcon>
				</Tooltip>
			) : null}
		</Group>
	)

	const control = inlineLabel ? (
		<Group gap="sm" align="flex-end" mih={36}>
			{labelContent}
			<div style={{ flex: 1 }}>{children}</div>
		</Group>
	) : (
		children
	)

	return (
		<Stack gap="xs" style={{ width: '100%' }}>
			{inlineLabel ? null : labelContent}
			{description ? (
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			) : null}
			{control}
			{errorText ? (
				<Text size="sm" c="red.6">
					{errorText}
				</Text>
			) : null}
			{helperText ? (
				<Text size="sm" c="dimmed">
					{helperText}
				</Text>
			) : null}
			{hint ? (
				<Text size="xs" c="dimmed">
					{hint}
				</Text>
			) : null}
		</Stack>
	)
}
