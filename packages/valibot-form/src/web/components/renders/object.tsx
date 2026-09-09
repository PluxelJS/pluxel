import { ActionIcon, Card, Collapse, Group, Stack, Text } from '@mantine/core'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type { FieldNode, ObjectFieldNode } from '../../../core/fields'
import { useFieldRenderer } from '../internal/fieldRendererContext'
import { alignToCss, resolveFieldSpan } from '../internal/layout'
import { planFieldSections } from '../internal/fieldPlanner'
import { joinErrorMessages, normalizeErrorMessages, type RendererProps } from './types'

export function ObjectField(props: RendererProps) {
	const { node, errors, inputProps } = props
	const info = node as ObjectFieldNode
	const renderFieldNode = useFieldRenderer()
	const baseErrors = normalizeErrorMessages(errors)

	const sections = useMemo(() => planFieldSections(info.fields), [info.fields])
	const [collapsed, setCollapsed] = useState(Boolean(info.collapsible && info.collapsed))

	const renderNestedField = (field: FieldNode) => {
		if (field.name === undefined) return null
		return renderFieldNode({
			node: field,
			path: [...props.path, field.name],
			disabled: inputProps.disabled,
			readOnly: inputProps.readOnly,
		})
	}

	const content = (
		<Stack gap={info.gap ?? 'md'}>
			{sections.sections.map((section) => (
				<Stack key={section.id} gap="sm">
					{section.title || section.description ? (
						<Stack gap={4}>
							{section.title ? <Text fw={600}>{section.title}</Text> : null}
							{section.description ? (
								<Text size="sm" c="dimmed">
									{section.description}
								</Text>
							) : null}
						</Stack>
					) : null}
					<div
						style={{
							display: 'grid',
							gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))`,
							gap: 'var(--mantine-spacing-md)',
						}}
					>
						{section.fields.map(({ name, node: field }) => {
							const span = resolveFieldSpan(section.columns, field.meta.layout, field.kind)
							return (
								<div
									key={name}
									style={{
										gridColumn: `span ${Math.min(span, section.columns)}`,
										alignSelf: alignToCss(field.meta.layout?.align),
									}}
								>
									{renderNestedField(field)}
								</div>
							)
						})}
					</div>
				</Stack>
			))}
		</Stack>
	)

	const header = node.meta.hideLabel ? null : (
		<Group justify="space-between" align="center" wrap="nowrap">
			<Group gap={8} align="center">
				<Text fw={600}>{node.meta.label}</Text>
				{info.collapsible ? (
					<ActionIcon
						variant="subtle"
						onClick={() => setCollapsed((prev) => !prev)}
						aria-label={collapsed ? '展开' : '折叠'}
						type="button"
					>
						{collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
					</ActionIcon>
				) : null}
			</Group>
			{node.meta.badge ? (
				<Text size="sm" c="dimmed">
					{typeof node.meta.badge === 'string' ? node.meta.badge : node.meta.badge.label}
				</Text>
			) : null}
		</Group>
	)

	if (info.variant === 'stack') {
		return (
			<Stack gap="sm">
				{node.meta.description ? (
					<Text size="sm" c="dimmed">
						{node.meta.description}
					</Text>
				) : null}
				{baseErrors.length > 0 ? (
					<Text id={inputProps.errorId} size="sm" c="red.6">
						{joinErrorMessages(baseErrors)}
					</Text>
				) : null}
				{info.collapsible ? <Collapse expanded={!collapsed}>{content}</Collapse> : content}
			</Stack>
		)
	}

	return (
		<Card withBorder shadow="xs" p="md">
			<Stack gap="sm">
				{header}
				{node.meta.description ? (
					<Text size="sm" c="dimmed">
						{node.meta.description}
					</Text>
				) : null}
				{baseErrors.length > 0 ? (
					<Text id={inputProps.errorId} size="sm" c="red.6" style={{ whiteSpace: 'pre-line' }}>
						{joinErrorMessages(baseErrors)}
					</Text>
				) : null}
				{info.collapsible ? <Collapse expanded={!collapsed}>{content}</Collapse> : content}
				{node.meta.help ? (
					<Text size="sm" c="dimmed">
						{node.meta.help}
					</Text>
				) : null}
			</Stack>
		</Card>
	)
}
